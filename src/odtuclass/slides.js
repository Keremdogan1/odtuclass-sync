import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

const SLIDES_DIR = path.resolve(process.cwd(), '.odtuclass', 'slides', 'CENG111');
const MANIFEST_PATH = path.join(SLIDES_DIR, 'manifest.json');

export function extractWeekKey(...texts) {
	for (const text of texts) {
		if (!text || typeof text !== 'string') continue;
		const match = text.match(/week\s*[-_]*0*(\d{1,2}[a-d]?)(?![0-9a-z])/i);
		if (match) {
			return match[1].toLowerCase();
		}
	}
	return null;
}

function sanitizeFilename(name) {
	const cleaned = name
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
}

function extractFilenameFromHeadersOrUrl(headers, finalUrl, fallbackName) {
	const contentDisposition = headers?.['content-disposition'] || '';
	if (contentDisposition) {
		const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;\r\n]+)/i);
		if (utf8Match) {
			try {
				return sanitizeFilename(decodeURIComponent(utf8Match[1].trim()));
			} catch {
				// fallback below
			}
		}
		const asciiMatch = contentDisposition.match(/filename="?([^";\r\n]+)"?/i);
		if (asciiMatch) {
			try {
				return sanitizeFilename(decodeURIComponent(asciiMatch[1].trim()));
			} catch {
				return sanitizeFilename(asciiMatch[1].trim());
			}
		}
	}

	if (finalUrl) {
		try {
			const parsed = new URL(finalUrl);
			const basename = decodeURIComponent(parsed.pathname.split('/').pop() || '');
			if (basename && basename.toLowerCase().endsWith('.pdf')) {
				return sanitizeFilename(basename);
			}
		} catch {
			// ignore
		}
	}

	return sanitizeFilename(fallbackName || 'slide.pdf');
}

async function loadManifest() {
	try {
		const raw = await fs.readFile(MANIFEST_PATH, 'utf8');
		const data = JSON.parse(raw);
		if (data && typeof data === 'object' && data.slides) {
			return data;
		}
	} catch {
		// ignore if not exists
	}
	return { version: 1, updatedAt: null, slides: {} };
}

async function saveManifest(manifest) {
	await fs.mkdir(SLIDES_DIR, { recursive: true });
	manifest.updatedAt = new Date().toISOString();
	await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

function collectCandidatesFromHtml(html, course, baseUrl, defaultSectionName = null) {
	const $ = cheerio.load(html);
	const candidates = [];
	const folderUrls = [];
	const pageUrls = [];
	const sectionUrls = [];

	$('a[href*="course/section.php?id="], a[href*="course/view.php"][href*="section="]').each(
		(_, el) => {
			const href = $(el).attr('href');
			const name = $(el).text().trim();
			if (href) {
				const resolved = new URL(href, baseUrl).href;
				if (!sectionUrls.some((s) => s.url === resolved)) {
					sectionUrls.push({ url: resolved, name });
				}
			}
		},
	);

	$('li.activity').each((_, element) => {
		const activity = $(element);
		const classes = activity.attr('class') || '';
		const sectionEl = activity.closest('li.section');
		const sectionName =
			sectionEl.find('.sectionname, h3.sectionname').first().text().trim() ||
			defaultSectionName;

		const instanceNameEl = activity.find('.instancename').clone();
		instanceNameEl.find('.accesshide').remove();
		const link = activity.find('a.aalink, a[href*="/mod/"]').first();
		const href = link.attr('href') || '';
		const cleanName =
			instanceNameEl.text().trim() ||
			link.text().replace(/\s+(File|Folder|URL|Page)$/i, '').trim();

		const badgeText = activity.find('.activitybadge').text().trim();
		console.log(
			`  [CENG111 Activity] course=${course.id} section="${sectionName || ''}" class="${classes}" name="${cleanName}" badge="${badgeText}" href="${href}"`,
		);

		if (!href) return;
		const resolvedUrl = new URL(href, baseUrl).href;

		if (href.includes('mod/folder/view.php')) {
			folderUrls.push({ url: resolvedUrl, name: cleanName, sectionName });
		} else if (href.includes('mod/page/view.php')) {
			pageUrls.push({ url: resolvedUrl, name: cleanName, sectionName });
		} else if (
			href.includes('mod/resource/view.php') ||
			href.includes('pluginfile.php') ||
			href.includes('mod/url/view.php')
		) {
			candidates.push({
				url: resolvedUrl,
				title: cleanName,
				sectionName,
				badgeText: badgeText.toLowerCase(),
			});
		}
	});

	// Also inspect any direct links to pluginfile.php or .pdf in summaries/tables
	$('a[href*="pluginfile.php"], a[href*="mod/resource/view.php"], a[href$=".pdf"]').each(
		(_, el) => {
			const href = $(el).attr('href');
			if (!href) return;
			const resolvedUrl = new URL(href, baseUrl).href;
			if (candidates.some((c) => c.url === resolvedUrl)) return;

			const text = $(el).text().trim() || decodeURIComponent(resolvedUrl.split('/').pop() || '');
			const sectionEl = $(el).closest('li.section');
			const sectionName =
				sectionEl.find('.sectionname, h3.sectionname').first().text().trim() ||
				defaultSectionName;

			console.log(
				`  [CENG111 DirectLink] course=${course.id} section="${sectionName || ''}" text="${text}" href="${resolvedUrl}"`,
			);
			candidates.push({
				url: resolvedUrl,
				title: text,
				sectionName,
				badgeText: '',
			});
		},
	);

	return { candidates, folderUrls, pageUrls, sectionUrls };
}

async function fetchPdfWithMeta(client, url, fallbackTitle) {
	const response = await client.request('GET', url, null, {
		responseType: 'arraybuffer',
	});

	let buffer = Buffer.from(response.data);
	let headers = response.headers;
	let finalUrl = response.finalUrl || url;

	const headerStr = buffer.slice(0, 200).toString('utf8');
	if (headerStr.includes('<!DOCTYPE') || headerStr.includes('<html')) {
		const html = buffer.toString('utf8');
		const $ = cheerio.load(html);

		const directLink = $(
			'a[href*="pluginfile.php"], object[data*="pluginfile.php"], iframe[src*="pluginfile.php"], embed[src*="pluginfile.php"], div.resourceworkaround a, div.urlworkaround a, a[href$=".pdf"]',
		).first();

		const downloadUrl =
			directLink.attr('href') ||
			directLink.attr('data') ||
			directLink.attr('src');

		if (!downloadUrl) {
			return null;
		}

		const resolvedUrl = new URL(downloadUrl, client.baseUrl).href;
		const pdfResponse = await client.request('GET', resolvedUrl, null, {
			responseType: 'arraybuffer',
		});
		buffer = Buffer.from(pdfResponse.data);
		headers = pdfResponse.headers;
		finalUrl = pdfResponse.finalUrl || resolvedUrl;
	}

	if (buffer.slice(0, 5).toString('utf8') !== '%PDF-') {
		return null;
	}

	const filename = extractFilenameFromHeadersOrUrl(headers, finalUrl, fallbackTitle);
	return { buffer, filename, finalUrl };
}

export async function syncCeng111Slides(client, courses) {
	const cengCourses = courses.filter((c) =>
		/ceng\s*111/i.test(`${c.fullname || ''} ${c.shortname || ''}`),
	);

	if (cengCourses.length === 0) {
		console.log('No CENG 111 courses found.');
		return [];
	}

	await fs.mkdir(SLIDES_DIR, { recursive: true });
	const manifest = await loadManifest();
	const syncedSlides = [];

	for (const course of cengCourses) {
		console.log(
			`\nInspecting CENG 111 course for slides: [${course.id}] ${course.fullname}`,
		);

		let mainHtml = '';
		try {
			const res = await client.request(
				'GET',
				`${client.baseUrl}/course/view.php?id=${course.id}`,
			);
			mainHtml = typeof res.data === 'string' ? res.data : Buffer.from(res.data).toString('utf8');
		} catch (err) {
			console.warn(`Failed to fetch CENG 111 course ${course.id}: ${err.message}`);
			continue;
		}

		const { candidates, folderUrls, pageUrls, sectionUrls } = collectCandidatesFromHtml(
			mainHtml,
			course,
			client.baseUrl,
		);

		console.log(
			`  Found ${candidates.length} candidate(s), ${folderUrls.length} folder(s), ${pageUrls.length} page(s), ${sectionUrls.length} section link(s) on main page.`,
		);

		// Inspect folders
		for (const folder of folderUrls) {
			try {
				console.log(`  Fetching CENG 111 folder: "${folder.name}" (${folder.url})`);
				const fRes = await client.request('GET', folder.url);
				const fHtml =
					typeof fRes.data === 'string'
						? fRes.data
						: Buffer.from(fRes.data).toString('utf8');
				const sub = collectCandidatesFromHtml(
					fHtml,
					course,
					client.baseUrl,
					folder.sectionName || folder.name,
				);
				for (const c of sub.candidates) {
					if (!candidates.some((existing) => existing.url === c.url)) {
						candidates.push(c);
					}
				}
			} catch (err) {
				console.warn(`  Failed to fetch folder ${folder.url}: ${err.message}`);
			}
		}

		// Inspect pages
		for (const page of pageUrls) {
			try {
				console.log(`  Fetching CENG 111 page: "${page.name}" (${page.url})`);
				const pRes = await client.request('GET', page.url);
				const pHtml =
					typeof pRes.data === 'string'
						? pRes.data
						: Buffer.from(pRes.data).toString('utf8');
				const sub = collectCandidatesFromHtml(
					pHtml,
					course,
					client.baseUrl,
					page.sectionName || page.name,
				);
				for (const c of sub.candidates) {
					if (!candidates.some((existing) => existing.url === c.url)) {
						candidates.push(c);
					}
				}
			} catch (err) {
				console.warn(`  Failed to fetch page ${page.url}: ${err.message}`);
			}
		}

		// Inspect section subpages in case activities are only rendered inside section.php
		for (const sec of sectionUrls) {
			try {
				const sRes = await client.request('GET', sec.url);
				const sHtml =
					typeof sRes.data === 'string'
						? sRes.data
						: Buffer.from(sRes.data).toString('utf8');
				const sub = collectCandidatesFromHtml(
					sHtml,
					course,
					client.baseUrl,
					sec.name,
				);
				for (const c of sub.candidates) {
					if (!candidates.some((existing) => existing.url === c.url)) {
						candidates.push(c);
					}
				}
				for (const folder of sub.folderUrls) {
					if (!folderUrls.some((f) => f.url === folder.url)) {
						const fRes = await client.request('GET', folder.url);
						const fHtml =
							typeof fRes.data === 'string'
								? fRes.data
								: Buffer.from(fRes.data).toString('utf8');
						const fSub = collectCandidatesFromHtml(
							fHtml,
							course,
							client.baseUrl,
							sec.name,
						);
						for (const c of fSub.candidates) {
							if (!candidates.some((existing) => existing.url === c.url)) {
								candidates.push(c);
							}
						}
					}
				}
			} catch (err) {
				console.warn(`  Failed to fetch section ${sec.url}: ${err.message}`);
			}
		}

		for (const cand of candidates) {
			if (/lab\s+section\s+scheduler/i.test(cand.title)) {
				continue;
			}
			// Skip explicitly non-PDF badges like zip, py, ipynb, mp4
			if (
				cand.badgeText &&
				!cand.badgeText.includes('pdf') &&
				/\b(zip|tar|gz|py|c|cpp|txt|mp4|mkv|html)\b/i.test(cand.badgeText)
			) {
				continue;
			}

			try {
				const pdfData = await fetchPdfWithMeta(client, cand.url, cand.title);
				if (!pdfData) {
					continue;
				}

				const { buffer, filename, finalUrl } = pdfData;
				const weekKey = extractWeekKey(filename, cand.title, cand.sectionName);
				const isSlideLike =
					Boolean(weekKey) ||
					/prelecture|lecture|slide|week|chap/i.test(
						`${filename} ${cand.title}`,
					);

				console.log(
					`  [CENG111 PDF] title="${cand.title}" filename="${filename}" weekKey=${weekKey || 'none'} isSlideLike=${isSlideLike} size=${buffer.length}`,
				);

				if (!isSlideLike) {
					continue;
				}

				const targetPath = path.join(SLIDES_DIR, filename);
				await fs.writeFile(targetPath, buffer);

				const slideEntry = {
					id: `slide:${course.id}:${filename}`,
					courseId: course.id,
					courseName: course.fullname,
					title: cand.title,
					filename,
					weekKey,
					url: cand.url,
					finalUrl,
					filesize: buffer.length,
					syncedAt: new Date().toISOString(),
				};

				manifest.slides[filename] = slideEntry;
				syncedSlides.push(slideEntry);
				console.log(`  Saved CENG 111 slide: ${filename} (weekKey: ${weekKey})`);
			} catch (err) {
				console.warn(
					`  Failed to inspect candidate "${cand.title}" (${cand.url}): ${err.message}`,
				);
			}
		}
	}

	await saveManifest(manifest);
	return syncedSlides;
}
