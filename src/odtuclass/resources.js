import * as cheerio from 'cheerio';
import { getCourseContents } from './assignments.js';

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
			if (module.modname !== 'resource') {
				continue;
			}

			const contents = module.contents || [];
			for (const file of contents) {
				const filename = file.filename || '';
				const mimetype = (file.mimetype || '').toLowerCase();
				const isPdf =
					mimetype === 'application/pdf' ||
					filename.toLowerCase().endsWith('.pdf') ||
					(file.fileurl && file.fileurl.toLowerCase().includes('.pdf'));

				if (isPdf) {
					resources.push({
						id: `resource:${course.id}:${module.id}`,
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

	return extractResourcesFromHtml(response.data, course, client.baseUrl);
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

		if (!isPdf) {
			return;
		}

		const resolvedUrl = baseUrl ? new URL(href, baseUrl).href : href;

		resources.push({
			id: `resource:${course.id}:${moduleId}`,
			type: 'resource',
			courseId: course.id,
			courseName: course.fullname,
			moduleId,
			name: cleanName,
			filename: `${cleanName.replace(/\.pdf$/i, '')}.pdf`,
			fileurl: resolvedUrl,
			filesize: null,
			timecreated: null,
			timemodified: null,
		});
	});

	return resources;
}

export async function fetchResourceBuffer(client, fileurl) {
	if (!fileurl) {
		throw new Error('fileurl is required to fetch resource buffer.');
	}

	const response = await client.request('GET', fileurl, null, {
		responseType: 'arraybuffer',
	});

	const buffer = Buffer.from(response.data);

	// If response is HTML instead of raw PDF, extract the embedded link
	const headerStr = buffer.slice(0, 100).toString('utf8');
	if (headerStr.includes('<!DOCTYPE') || headerStr.includes('<html')) {
		const html = buffer.toString('utf8');
		const $ = cheerio.load(html);

		const directLink = $(
			'a[href*="pluginfile.php"], object[data*="pluginfile.php"], iframe[src*="pluginfile.php"], embed[src*="pluginfile.php"], div.resourceworkaround a, a[href$=".pdf"]',
		).first();

		const downloadUrl =
			directLink.attr('href') ||
			directLink.attr('data') ||
			directLink.attr('src');

		if (downloadUrl) {
			const resolvedUrl = new URL(downloadUrl, client.baseUrl).href;
			const pdfResponse = await client.request('GET', resolvedUrl, null, {
				responseType: 'arraybuffer',
			});
			return Buffer.from(pdfResponse.data);
		}
	}

	return buffer;
}
