import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { extractPdfText } from '../pdf/extractor.js';
import { classifyPdf } from '../pdf/classifier.js';

const SLIDES_ROOT_DIR = path.resolve(process.cwd(), '.odtuclass', 'slides');
const ROOT_MANIFEST_PATH = path.join(SLIDES_ROOT_DIR, 'manifest.json');
const MAX_SLIDE_BYTES = 50 * 1024 * 1024; // 50 MB safety cap for GitHub

export function extractCourseCode(course) {
	const text = `${course?.fullname || ''} ${course?.shortname || ''}`;
	const match = text.match(/\b([A-Z]{2,4})\s*(\d{3})\b/i);
	if (match) {
		return `${match[1].toUpperCase()}${match[2]}`;
	}
	return `COURSE_${course?.id || 'UNKNOWN'}`;
}

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

export function formatStandardSlideFilename(filename, weekKey, title = '') {
	const rawName = String(filename || '').trim();
	const combined = `${rawName} ${title || ''}`;
	const yearMatch = combined.match(/\b(20\d{2})\b/);
	const year = yearMatch ? yearMatch[1] : '2026';
	const wk = weekKey || extractWeekKey(rawName, title);
	if (wk) {
		const isPrelecture = /pre-?lecture/i.test(combined);
		const suffix = isPrelecture ? ' Prelecture' : '';
		return `${year} Week ${wk}${suffix}.pdf`;
	}
	return rawName.toLowerCase().endsWith('.pdf') ? rawName : `${rawName}.pdf`;
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

async function loadRootManifest() {
	let rootManifest = { version: 2, updatedAt: null, slides: {}, evaluatedNonSlides: {} };
	try {
		const raw = await fs.readFile(ROOT_MANIFEST_PATH, 'utf8');
		const data = JSON.parse(raw);
		if (data && typeof data === 'object') {
			rootManifest = {
				version: 2,
				updatedAt: data.updatedAt || null,
				slides: data.slides || {},
				evaluatedNonSlides: data.evaluatedNonSlides || {},
			};
		}
	} catch {
		// Also migrate any existing CENG111 manifest entries if present
		try {
			const cengManifestPath = path.join(SLIDES_ROOT_DIR, 'CENG111', 'manifest.json');
			const cengRaw = await fs.readFile(cengManifestPath, 'utf8');
			const cengData = JSON.parse(cengRaw);
			if (cengData?.slides) {
				for (const [k, v] of Object.entries(cengData.slides)) {
					const entry = { ...v, courseCode: 'CENG111' };
					rootManifest.slides[`CENG111/${k}`] = entry;
				}
			}
		} catch {
			// ignore
		}
	}
	return rootManifest;
}

async function saveRootManifest(manifest) {
	await fs.mkdir(SLIDES_ROOT_DIR, { recursive: true });
	manifest.updatedAt = new Date().toISOString();
	await fs.writeFile(ROOT_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

function collectCandidatesFromHtml(html, course, baseUrl, defaultSectionName = null, folderName = null) {
	const $ = cheerio.load(html);
	const candidates = [];
	const folderUrls = [];

	$('li.activity').each((_, element) => {
		const activity = $(element);
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

		if (!href) return;
		const resolvedUrl = new URL(href, baseUrl).href;

		if (href.includes('mod/folder/view.php')) {
			if (!/textbook|syllabus|past\s+exam/i.test(cleanName)) {
				folderUrls.push({ url: resolvedUrl, name: cleanName, sectionName });
			}
		} else if (
			href.includes('mod/resource/view.php') ||
			href.includes('pluginfile.php')
		) {
			candidates.push({
				url: resolvedUrl,
				title: cleanName,
				sectionName,
				folderName,
				badgeText: badgeText.toLowerCase(),
			});
		}
	});

	$('a[href*="pluginfile.php"], a[href$=".pdf"]').each((_, el) => {
		const href = $(el).attr('href');
		if (!href) return;
		const resolvedUrl = new URL(href, baseUrl).href;
		if (candidates.some((c) => c.url === resolvedUrl)) return;

		const text =
			$(el).text().trim() ||
			decodeURIComponent(resolvedUrl.split('/').pop() || '');
		const sectionEl = $(el).closest('li.section');
		const sectionName =
			sectionEl.find('.sectionname, h3.sectionname').first().text().trim() ||
			defaultSectionName;

		candidates.push({
			url: resolvedUrl,
			title: text,
			sectionName,
			folderName,
			badgeText: '',
		});
	});

	return { candidates, folderUrls };
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

const OBVIOUS_NON_SLIDE_REGEX =
	/syllabus|course\s+outline|na\s+criteria|rubric|guideline|academic\s+integrity|scheduler|teams\s+account|textbook|recitation|solved\s+problem|exercise|announcement|pearson\s+help|weekly\s+program|schedule\s+of\s+lecture|genai\s+use/i;

export async function syncAllCourseSlides(client, courses) {
	await fs.mkdir(SLIDES_ROOT_DIR, { recursive: true });
	const manifest = await loadRootManifest();
	const syncedSlides = [];

	for (const course of courses) {
		const courseCode = extractCourseCode(course);
		let mainHtml = '';
		try {
			const res = await client.request(
				'GET',
				`${client.baseUrl}/course/view.php?id=${course.id}`,
			);
			mainHtml =
				typeof res.data === 'string'
					? res.data
					: Buffer.from(res.data).toString('utf8');
		} catch (err) {
			console.warn(`Failed to fetch course ${course.id} for slides: ${err.message}`);
			continue;
		}

		const { candidates, folderUrls } = collectCandidatesFromHtml(
			mainHtml,
			course,
			client.baseUrl,
		);

		for (const folder of folderUrls) {
			try {
				console.log(
					`  [${courseCode}] Fetching folder: "${folder.name}" (${folder.url})`,
				);
				const fRes = await client.request('GET', folder.url);
				const fHtml =
					typeof fRes.data === 'string'
						? fRes.data
						: Buffer.from(fRes.data).toString('utf8');
				const sub = collectCandidatesFromHtml(
					fHtml,
					course,
					client.baseUrl,
					folder.sectionName,
					folder.name,
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

		for (const cand of candidates) {
			const combinedTitle = `${cand.title} ${cand.url}`;
			if (OBVIOUS_NON_SLIDE_REGEX.test(combinedTitle)) {
				continue;
			}
			if (
				cand.badgeText &&
				!cand.badgeText.includes('pdf') &&
				/\b(zip|tar|gz|py|c|cpp|txt|mp4|mkv|html|doc|docx|xls|xlsx)\b/i.test(
					cand.badgeText,
				)
			) {
				continue;
			}

			// Skip if already evaluated as non-slide
			if (manifest.evaluatedNonSlides[cand.url]) {
				continue;
			}

			// Skip if already synced and file exists on disk
			const existingEntry = Object.values(manifest.slides).find(
				(s) => s.url === cand.url && s.courseCode === courseCode,
			);
			if (existingEntry) {
				const existingDiskPath = path.join(
					SLIDES_ROOT_DIR,
					courseCode,
					existingEntry.filename,
				);
				try {
					await fs.access(existingDiskPath);
					continue;
				} catch {
					// re-download if missing from disk
				}
			}

			try {
				const pdfData = await fetchPdfWithMeta(client, cand.url, cand.title);
				if (!pdfData) {
					manifest.evaluatedNonSlides[cand.url] = {
						title: cand.title,
						reason: 'Not a PDF',
						evaluatedAt: new Date().toISOString(),
					};
					continue;
				}

				const { buffer, filename, finalUrl } = pdfData;
				if (
					buffer.length > MAX_SLIDE_BYTES ||
					OBVIOUS_NON_SLIDE_REGEX.test(filename)
				) {
					manifest.evaluatedNonSlides[cand.url] = {
						title: cand.title,
						filename,
						reason: 'Oversized or non-slide filename',
						evaluatedAt: new Date().toISOString(),
					};
					continue;
				}

				const slideKey = `${courseCode}/${filename}`;
				const courseSlideDir = path.join(SLIDES_ROOT_DIR, courseCode);
				const targetPath = path.join(courseSlideDir, filename);

				// Check if already in manifest by filename and exists on disk
				if (manifest.slides[slideKey]) {
					try {
						await fs.access(targetPath);
						continue;
					} catch {
						// proceed
					}
				}

				let pdfText = '';
				try {
					pdfText = await extractPdfText(buffer);
				} catch {
					// ignore text extraction failure
				}

				const classification = await classifyPdf(
					{
						courseName: course.fullname,
						name: cand.title,
						filename,
						folderName: cand.folderName,
						sectionName: cand.sectionName,
					},
					pdfText,
				);

				const weekKey = extractWeekKey(
					filename,
					cand.title,
					cand.sectionName,
					cand.folderName,
				);
				const inSlidesFolder = /slide|slayt|lecture\s*note/i.test(
					cand.folderName || '',
				);
				const isSlide =
					classification.isSlide ||
					classification.format === 'lecture_slides' ||
					(inSlidesFolder && !classification.isAssignment);

				console.log(
					`  [${courseCode} Slide Check] "${filename}" -> isSlide=${isSlide} (${classification.reason})`,
				);

				if (!isSlide) {
					manifest.evaluatedNonSlides[cand.url] = {
						courseCode,
						title: cand.title,
						filename,
						reason: classification.reason,
						evaluatedAt: new Date().toISOString(),
					};
					continue;
				}

				await fs.mkdir(courseSlideDir, { recursive: true });
				await fs.writeFile(targetPath, buffer);

				const slideEntry = {
					id: `slide:${courseCode}:${filename}`,
					courseId: course.id,
					courseName: course.fullname,
					courseCode,
					title: cand.title,
					filename,
					formattedFilename: formatStandardSlideFilename(
						filename,
						weekKey,
						cand.title,
					),
					weekKey,
					url: cand.url,
					finalUrl,
					filesize: buffer.length,
					reason: classification.reason,
					syncedAt: new Date().toISOString(),
				};

				manifest.slides[slideKey] = slideEntry;
				syncedSlides.push(slideEntry);
				console.log(
					`  [${courseCode}] Saved slide: ${filename} (weekKey: ${weekKey || 'none'})`,
				);
			} catch (err) {
				console.warn(
					`  [${courseCode}] Failed to inspect candidate "${cand.title}": ${err.message}`,
				);
			}
		}
	}

	await saveRootManifest(manifest);
	return syncedSlides;
}

export const syncCeng111Slides = syncAllCourseSlides;
