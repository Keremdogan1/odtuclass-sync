import * as cheerio from 'cheerio';
import { getCourseContents } from './assignments.js';
import { detectOfficeType, convertOfficeBufferToPdf } from '../pdf/officeConverter.js';

export async function getCourseResources(client, courses) {
	const resources = [];

	for (const course of courses) {
		let courseResources = [];

		try {
			const sections = await getCourseContents(client, course.id);
			courseResources = extractResourcesFromApi(course, sections);
		} catch (error) {
			// When Moodle web services are disabled, scrape course HTML
			try {
				courseResources = await scrapeResourcesFromHtml(client, course);
			} catch (htmlError) {
				console.warn(
					`Failed to scrape resources for course ${course.id}: ${htmlError.message}`,
				);
			}
		}

		resources.push(...courseResources);
	}

	return resources;
}

export function extractResourcesFromApi(course, sections) {
	const resources = [];

	for (const section of sections || []) {
		for (const module of section.modules || []) {
			if (module.modname !== 'resource' && module.modname !== 'folder') {
				continue;
			}

			const contents = module.contents || [];
			for (const file of contents) {
				const filename = file.filename || '';
				const mimetype = (file.mimetype || '').toLowerCase();
				const isSupportedDoc =
					mimetype === 'application/pdf' ||
					mimetype.includes('wordprocessingml') ||
					mimetype.includes('msword') ||
					/\.(pdf|docx|doc)$/i.test(filename) ||
					(file.fileurl && /\.(pdf|docx|doc)(\?|$)/i.test(file.fileurl));

				if (isSupportedDoc) {
					resources.push({
						id: `resource:${course.id}:${module.id}:${filename || 'doc'}`,
						type: 'resource',
						courseId: course.id,
						courseName: course.fullname,
						sectionId: section.id,
						sectionName: section.name,
						moduleId: module.id,
						name: module.name || filename,
						filename,
						fileurl: file.fileurl,
						filesize: file.filesize,
						timecreated: file.timecreated,
						timemodified: file.timemodified,
					});
				}
			}
		}
	}

	return resources;
}

export async function scrapeResourcesFromHtml(client, course) {
	const response = await client.request(
		'GET',
		`${client.baseUrl}/course/view.php?id=${course.id}`,
	);

	const mainResources = extractResourcesFromHtml(response.data, course, client.baseUrl);
	const $ = cheerio.load(response.data);
	const folderLinks = [];

	$('li.activity').each((_, element) => {
		const activity = $(element);
		const link = activity.find('a[href*="mod/folder/view.php"]').first();
		if (!link.length) return;
		const href = link.attr('href') || '';
		const instanceNameEl = activity.find('.instancename').clone();
		instanceNameEl.find('.accesshide').remove();
		const folderName = instanceNameEl.text().trim() || link.text().trim();
		// Skip pure slide/textbook folders in assignment resource scraper
		if (/^slides$|textbook|past\s+exam/i.test(folderName)) {
			return;
		}
		const match = href.match(/id=(\d+)/);
		const folderId = match ? Number(match[1]) : null;
		if (folderId) {
			folderLinks.push({
				folderId,
				folderName,
				url: new URL(href, client.baseUrl).href,
			});
		}
	});

	for (const folder of folderLinks) {
		try {
			const fRes = await client.request('GET', folder.url);
			const fHtml = typeof fRes.data === 'string' ? fRes.data : Buffer.from(fRes.data).toString('utf8');
			const $f = cheerio.load(fHtml);
			$f('#region-main a[href*="pluginfile.php"], div[role="main"] a[href*="pluginfile.php"]').each((idx, el) => {
				const fileHref = $f(el).attr('href') || '';
				if (!fileHref) return;
				const resolvedUrl = new URL(fileHref, client.baseUrl).href;
				const rawFileName =
					$f(el).find('.fp-filename').text().trim() ||
					$f(el).text().trim() ||
					decodeURIComponent(resolvedUrl.split('?')[0].split('/').pop() || '');
				if (!/\.(pdf|docx|doc)$/i.test(rawFileName) && !/\.(pdf|docx|doc)(\?|$)/i.test(resolvedUrl)) {
					return;
				}
				const safeSlug = rawFileName.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40);
				const id = `resource:${course.id}:${folder.folderId}-${safeSlug || idx}`;
				if (!mainResources.some((r) => r.fileurl === resolvedUrl || r.id === id)) {
					mainResources.push({
						id,
						type: 'resource',
						courseId: course.id,
						courseName: course.fullname,
						moduleId: `${folder.folderId}-${idx}`,
						folderName: folder.folderName,
						name: rawFileName.replace(/\.(pdf|docx|doc)$/i, ''),
						filename: rawFileName,
						fileurl: resolvedUrl,
						filesize: null,
						timecreated: null,
						timemodified: null,
					});
				}
			});
		} catch (err) {
			console.warn(`Failed to scrape folder ${folder.url}: ${err.message}`);
		}
	}

	return mainResources;
}

export function extractResourcesFromHtml(html, course, baseUrl = '') {
	const $ = cheerio.load(html);
	const resources = [];

	$('li.activity').each((_, element) => {
		const activity = $(element);
		let moduleType = null;

		for (const className of activity.attr('class')?.split(/\s+/) || []) {
			if (className.startsWith('modtype_')) {
				moduleType = className.replace('modtype_', '');
				break;
			}
			if (className.startsWith('modtype-')) {
				moduleType = className.replace('modtype-', '');
				break;
			}
		}

		if (moduleType !== 'resource') {
			return;
		}

		const link = activity
			.find('a.aalink, a[href*="mod/resource/view.php"]')
			.first();
		if (!link.length) {
			return;
		}

		const href = link.attr('href') || '';
		const match = href.match(/id=(\d+)/);
		const moduleId = match ? Number(match[1]) : null;
		if (!moduleId) {
			return;
		}

		const badgeText = activity
			.find('.activitybadge')
			.text()
			.trim()
			.toLowerCase();
		const iconSrc = activity.find('img.activityicon').attr('src') || '';

		const instanceNameEl = activity.find('.instancename').clone();
		instanceNameEl.find('.accesshide').remove();
		const cleanName =
			instanceNameEl.text().trim() ||
			link.text().replace(/\s+File$/i, '').trim();

		const isPdf =
			badgeText.includes('pdf') ||
			iconSrc.includes('/f/pdf') ||
			cleanName.toLowerCase().endsWith('.pdf');

		const isWord =
			badgeText.includes('doc') ||
			badgeText.includes('word') ||
			badgeText.includes('rtf') ||
			iconSrc.includes('/f/document') ||
			/\.(docx|doc|rtf)$/i.test(cleanName);

		if (!isPdf && !isWord) {
			return;
		}

		const resolvedUrl = baseUrl ? new URL(href, baseUrl).href : href;
		const defaultExt = isWord ? '.docx' : '.pdf';
		const filename = /\.(pdf|docx|doc|rtf)$/i.test(cleanName)
			? cleanName
			: `${cleanName}${defaultExt}`;

		resources.push({
			id: `resource:${course.id}:${moduleId}`,
			type: 'resource',
			courseId: course.id,
			courseName: course.fullname,
			moduleId,
			name: cleanName,
			filename,
			fileurl: resolvedUrl,
			filesize: null,
			timecreated: null,
			timemodified: null,
		});
	});

	return resources;
}

export async function fetchResourceBuffer(client, fileurl, fallbackFilename = 'resource.pdf') {
	if (!fileurl) {
		throw new Error('fileurl is required to fetch resource buffer.');
	}

	const response = await client.request('GET', fileurl, null, {
		responseType: 'arraybuffer',
	});

	let buffer = Buffer.from(response.data);
	let headers = response.headers || {};
	let finalUrl = response.finalUrl || fileurl;

	// If response is HTML instead of raw file, extract the embedded link from main content region
	const headerStr = buffer.slice(0, 200).toString('utf8');
	if (headerStr.includes('<!DOCTYPE') || headerStr.includes('<html')) {
		const html = buffer.toString('utf8');
		const $ = cheerio.load(html);

		const directLink = $(
			'div.resourceworkaround a, div.urlworkaround a, #region-main a[href*="pluginfile.php"], div[role="main"] a[href*="pluginfile.php"], object[data*="pluginfile.php"], iframe[src*="pluginfile.php"], embed[src*="pluginfile.php"], a[href$=".pdf"], a[href$=".docx"], a[href$=".doc"], a[href$=".pptx"], a[href$=".ppt"]',
		).first();

		const downloadUrl =
			directLink.attr('href') ||
			directLink.attr('data') ||
			directLink.attr('src');

		if (downloadUrl) {
			const resolvedUrl = new URL(downloadUrl, client.baseUrl).href;
			const fileResponse = await client.request('GET', resolvedUrl, null, {
				responseType: 'arraybuffer',
			});
			buffer = Buffer.from(fileResponse.data);
			headers = fileResponse.headers || {};
			finalUrl = fileResponse.finalUrl || resolvedUrl;
		}
	}

	if (buffer.slice(0, 5).toString('utf8') === '%PDF-') {
		return buffer;
	}

	const contentType = headers['content-type'] || '';
	const officeType = detectOfficeType(buffer, finalUrl || fallbackFilename, contentType);
	if (officeType) {
		console.log(`  [Office->PDF] Converting ${officeType.toUpperCase()} resource "${fallbackFilename}" to PDF...`);
		const converted = await convertOfficeBufferToPdf(buffer, fallbackFilename, officeType);
		return converted.buffer;
	}

	return buffer;
}

