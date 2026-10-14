import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { extractPdfText } from '../pdf/extractor.js';
import { detectOfficeType, convertOfficeBufferToPdf } from '../pdf/officeConverter.js';
import { extractCourseCode } from './slides.js';

const SYLLABI_ROOT_DIR = path.resolve(process.cwd(), '.odtuclass', 'syllabi');
const MANIFEST_PATH = path.join(SYLLABI_ROOT_DIR, 'manifest.json');
const PENDING_DIR = path.resolve(process.cwd(), '.odtuclass', 'pending');
const MAX_PDF_BYTES = 40 * 1024 * 1024;

const SYLLABUS_NAME_REGEX =
	/\b(?:syllabus|course\s+outline|course\s+policy|course\s+policies|course\s+information(?:\s+sheet)?|ders\s+izlencesi|ders\s+program[ıi]|information\s+input|101\s+course\s+outline|105.*syllabus|119.*syllabus)\b/i;

async function loadManifest() {
	try {
		const raw = await fs.readFile(MANIFEST_PATH, 'utf8');
		return JSON.parse(raw);
	} catch {
		return { version: 1, updatedAt: new Date().toISOString(), syllabi: {} };
	}
}

async function saveManifest(manifest) {
	manifest.updatedAt = new Date().toISOString();
	await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

function extractFilenameFromHeadersOrUrl(headers, finalUrl, fallbackName) {
	const disposition = headers['content-disposition'] || '';
	const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
	if (match) {
		try {
			return decodeURIComponent(match[1].trim());
		} catch {
			return match[1].trim();
		}
	}
	try {
		const parsed = new URL(finalUrl);
		const lastPart = parsed.pathname.split('/').filter(Boolean).pop();
		if (lastPart && lastPart.toLowerCase().endsWith('.pdf')) {
			return decodeURIComponent(lastPart);
		}
	} catch {}
	return fallbackName || 'Syllabus.pdf';
}

async function fetchPdfWithMeta(client, url, fallbackTitle) {
	const response = await client.request('GET', url, null, {
		responseType: 'arraybuffer',
	});

	let buffer = Buffer.from(response.data);
	let headers = response.headers || {};
	let finalUrl = response.finalUrl || url;

	const headerStr = buffer.slice(0, 200).toString('utf8');
	if (headerStr.includes('<!DOCTYPE') || headerStr.includes('<html')) {
		const html = buffer.toString('utf8');
		const $ = cheerio.load(html);

		const directLink = $(
			'div.resourceworkaround a, div.urlworkaround a, #region-main a[href*="pluginfile.php"], div[role="main"] a[href*="pluginfile.php"], object[data*="pluginfile.php"], iframe[src*="pluginfile.php"], embed[src*="pluginfile.php"], a[href$=".pdf"], a[href$=".docx"], a[href$=".doc"]',
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
		headers = pdfResponse.headers || {};
		finalUrl = pdfResponse.finalUrl || resolvedUrl;
	}

	const filename = extractFilenameFromHeadersOrUrl(headers, finalUrl, fallbackTitle);

	if (buffer.slice(0, 5).toString('utf8') === '%PDF-') {
		return { buffer, filename, finalUrl, officeType: null };
	}

	const contentType = headers['content-type'] || '';
	const officeType = detectOfficeType(buffer, finalUrl || filename, contentType);
	if (officeType) {
		console.log(`  [Office->PDF] Converting syllabus ${officeType.toUpperCase()} "${fallbackTitle}" (${filename}) to PDF...`);
		const converted = await convertOfficeBufferToPdf(buffer, filename, officeType);
		return {
			buffer: converted.buffer,
			filename: filename.replace(/\.(docx|doc|odt|rtf)$/i, '.pdf'),
			finalUrl,
			officeType,
		};
	}

	return null;
}

export async function extractSyllabusWithGemini(pdfText, course, apiKey = process.env.GEMINI_API_KEY) {
	if (!apiKey || !pdfText || pdfText.trim().length < 50) {
		return fallbackSyllabusExtraction(pdfText);
	}

	const textExcerpt = pdfText.slice(0, 15000); // Send up to 15,000 characters for rich syllabus parsing
	const prompt = `You are an academic course assistant extracting structured information from a university syllabus/course outline document.
Analyze the following course syllabus text for ${course.fullname || course.shortname || 'Course'}.

Extract:
1. "exams": List of scheduled exams. For each exam:
   - "title": Name of exam (e.g. "Midterm Exam 1", "Midterm Exam 2", "Final Exam")
   - "date": Date in "YYYY-MM-DD" format if explicitly stated or determinable from 2026/2027 academic year; else null
   - "time": Time string (e.g. "14:00" or "09:40-11:30") if stated, else null
   - "weight": Grading percentage/weight (e.g. "%25", "%30") if stated, else null
   - "location": Room / classroom or online if stated, else null
   - "notes": Any important details (e.g. "Chapters 1-4 included")

2. "grading": List of grading components and weight percentages:
   - "component": Name of component (e.g. "Midterm 1", "Midterm 2", "Final Exam", "Quizzes", "Lab Work", "Homework", "Participation")
   - "weight": Weight percentage as string with % (e.g. "%25", "%15")
   - "notes": Short notes/conditions (e.g. "Best 4 out of 5", "NA criteria: < 30 on midterms")

3. "weeklySchedule": List of weekly schedule items:
   - "week": Week number (integer)
   - "dates": Date range string (e.g. "Oct 2 - Oct 6") if mentioned, else null
   - "topic": Covered topic / lecture title
   - "readings": Assigned chapters or readings if mentioned, else null

4. "textbooks": List of required or recommended textbook titles and authors as strings.

5. "instructors": List of course instructors/coordinators:
   - "name": Name with title
   - "email": Email address if found, else null
   - "office": Office room if found, else null

6. "summary": A concise 2-sentence summary of the course scope and evaluation policy.

Course: ${course.fullname}
Text:
${textExcerpt}

Respond ONLY with valid JSON in this exact structure without markdown backticks:
{
  "exams": [],
  "grading": [],
  "weeklySchedule": [],
  "textbooks": [],
  "instructors": [],
  "summary": ""
}`;

	const candidateModels = [
		process.env.GEMINI_MODEL,
		'gemini-flash-latest',
		'gemini-3-flash-preview',
		'gemini-2.5-flash',
	].filter(Boolean);

	for (const model of candidateModels) {
		try {
			const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: {
						temperature: 0.1,
						responseMimeType: 'application/json',
					},
				}),
			});

			if (!response.ok) {
				continue;
			}

			const data = await response.json();
			const contentText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
			if (!contentText) continue;

			return JSON.parse(contentText);
		} catch (err) {
			console.warn(`[Syllabus Gemini] Error with model ${model}: ${err.message}`);
		}
	}

	return fallbackSyllabusExtraction(pdfText);
}

function fallbackSyllabusExtraction(pdfText = '') {
	const grading = [];
	const exams = [];
	const textbooks = [];
	const weeklySchedule = [];

	// Basic regex for grading percentages (e.g. Midterm 30%, Final: 40%)
	const gradeLines = pdfText.match(/(?:midterm|final|quiz|homework|hw|lab|attendance|project)[\w\s:.-]{1,30}(?:%\s*\d{1,2}|\d{1,2}\s*%)/gi) || [];
	for (const line of gradeLines.slice(0, 10)) {
		const pctMatch = line.match(/(\d{1,2})\s*%/);
		if (pctMatch) {
			grading.push({
				component: line.replace(/%\s*\d{1,2}|\d{1,2}\s*%/g, '').trim(),
				weight: `%${pctMatch[1]}`,
				notes: '',
			});
		}
	}

	return {
		exams,
		grading,
		weeklySchedule,
		textbooks,
		instructors: [],
		summary: 'Syllabus document extracted.',
	};
}

export async function syncCourseSyllabi(client, courses) {
	await fs.mkdir(SYLLABI_ROOT_DIR, { recursive: true });
	await fs.mkdir(PENDING_DIR, { recursive: true });

	const manifest = await loadManifest();
	const synced = [];

	for (const course of courses) {
		const courseCode = extractCourseCode(course);
		console.log(`\n[Syllabus] Scanning syllabus for ${courseCode} (${course.fullname})...`);

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
			console.warn(`  Failed to fetch course view: ${err.message}`);
			continue;
		}

		const $ = cheerio.load(mainHtml);
		const candidates = [];

		// 1. Search activities on main page
		$('li.activity').each((_, el) => {
			const activity = $(el);
			const link = activity.find('a.aalink, a').first();
			const href = link.attr('href');
			const title =
				activity.find('.instancename').text().replace(/\s+(File|Folder|URL|Page)$/i, '').trim() ||
				link.text().trim();

			if (!href) return;
			const combined = `${title} ${href}`;

			if (
				SYLLABUS_NAME_REGEX.test(combined) ||
				(courseCode === 'CENG111' && /CENG111_Fall2026/i.test(combined))
			) {
				candidates.push({
					url: new URL(href, client.baseUrl).href,
					title,
					isFolder: href.includes('mod/folder/view.php'),
				});
			}
		});

		// 2. Also check any folders for syllabus files (e.g. CENG111 folder containing CENG111_Fall2026.pdf)
		$('li.activity.modtype_folder a.aalink, a[href*="mod/folder/view.php"]').each((_, el) => {
			const folderUrl = $(el).attr('href');
			const folderTitle = $(el).text().trim();
			if (!folderUrl) return;

			if (/syllabus|outline|info|course\s+materials/i.test(folderTitle) || courseCode === 'CENG111') {
				candidates.push({
					url: new URL(folderUrl, client.baseUrl).href,
					title: folderTitle,
					isFolder: true,
				});
			}
		});

		// 3. Inspect folder contents if needed
		const directPdfCandidates = [];
		for (const cand of candidates) {
			if (cand.isFolder) {
				try {
					const fRes = await client.request('GET', cand.url);
					const fHtml =
						typeof fRes.data === 'string'
							? fRes.data
							: Buffer.from(fRes.data).toString('utf8');
					const $f = cheerio.load(fHtml);
					$f('a[href*="pluginfile.php"], a[href$=".pdf"]').each((_, fel) => {
						const fhref = $f(fel).attr('href');
						const ftext = $f(fel).text().trim();
						if (!fhref) return;
						const combined = `${ftext} ${fhref}`;
						if (
							SYLLABUS_NAME_REGEX.test(combined) ||
							(courseCode === 'CENG111' && /CENG111_Fall2026/i.test(combined))
						) {
							directPdfCandidates.push({
								url: new URL(fhref, client.baseUrl).href,
								title: ftext || cand.title,
							});
						}
					});
				} catch (err) {
					console.warn(`  Failed to inspect folder ${cand.url}: ${err.message}`);
				}
			} else {
				directPdfCandidates.push(cand);
			}
		}

		if (directPdfCandidates.length === 0) {
			console.log(`  [${courseCode}] No explicit syllabus resource found.`);
			continue;
		}

		// Pick best candidate
		const chosen = directPdfCandidates[0];
		console.log(`  [${courseCode}] Found syllabus candidate: "${chosen.title}" (${chosen.url})`);

		try {
			const pdfData = await fetchPdfWithMeta(client, chosen.url, chosen.title);
			if (!pdfData) {
				console.warn(`  [${courseCode}] Could not fetch valid PDF for syllabus.`);
				continue;
			}

			const { buffer, filename } = pdfData;
			if (buffer.length > MAX_PDF_BYTES) {
				console.warn(`  [${courseCode}] Syllabus file too large (${buffer.length} bytes). Skipping.`);
				continue;
			}

			const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
			const prevEntry = manifest.syllabi[courseCode];

			const courseDir = path.join(SYLLABI_ROOT_DIR, courseCode);
			await fs.mkdir(courseDir, { recursive: true });
			const pdfSavePath = path.join(courseDir, 'Syllabus.pdf');

			// Save or update disk copy
			await fs.writeFile(pdfSavePath, buffer);

			if (prevEntry && prevEntry.contentHash === contentHash) {
				console.log(`  [${courseCode}] Syllabus already up to date (hash matches).`);
				continue;
			}

			console.log(`  [${courseCode}] Extracting text and structured details...`);
			let pdfText = '';
			try {
				pdfText = await extractPdfText(buffer);
			} catch (txtErr) {
				console.warn(`  Failed to extract text from PDF: ${txtErr.message}`);
			}

			const details = await extractSyllabusWithGemini(pdfText, course);

			const syllabusRecord = {
				id: `syllabus:${courseCode}`,
				type: 'syllabus',
				courseCode,
				courseName: course.fullname,
				courseId: course.id,
				originalFilename: filename,
				pdfFilename: 'Syllabus 2026 Fall.pdf',
				sourceUrl: chosen.url,
				contentHash,
				syncedAt: new Date().toISOString(),
				extracted: details,
				event: 'created',
			};

			manifest.syllabi[courseCode] = syllabusRecord;
			await saveManifest(manifest);

			// Write pending file for Obsidian plugin consumption
			const pendingPath = path.join(PENDING_DIR, `syllabus-${courseCode}.json`);
			await fs.writeFile(pendingPath, JSON.stringify(syllabusRecord, null, 2), 'utf8');
			console.log(`  [${courseCode}] Syllabus written to pending: ${pendingPath}`);

			synced.push(syllabusRecord);
		} catch (itemErr) {
			console.error(`  [${courseCode}] Error syncing syllabus: ${itemErr.message}`);
		}
	}

	return synced;
}
