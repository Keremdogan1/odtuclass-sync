import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';

/**
 * Parses US-style date strings produced by Pearson platforms:
 * - MyLab: "11/10/26 11:59pm", "09/10/26 11:59pm"
 * - Mastering: "12/31/2026 11:59 PM", "10/15/2026 11:59 PM"
 */
export function parsePearsonDate(rawStr, referenceYear = 2026) {
	if (!rawStr || typeof rawStr !== 'string') return null;

	const cleaned = rawStr.trim();

	// Match: Month/Day/Year Time (AM/PM)
	// e.g. 11/10/26 11:59pm or 12/31/2026 11:59 PM
	const match = cleaned.match(
		/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i,
	);

	if (!match) {
		// Fallback match for just date: MM/DD/YYYY
		const dateOnlyMatch = cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
		if (dateOnlyMatch) {
			const month = parseInt(dateOnlyMatch[1], 10);
			const day = parseInt(dateOnlyMatch[2], 10);
			let year = parseInt(dateOnlyMatch[3], 10);
			if (year < 100) year += 2000;
			const pad = (n) => String(n).padStart(2, '0');
			return `${year}-${pad(month)}-${pad(day)}T20:59:00.000Z`; // Default end of day UTC
		}
		return null;
	}

	const month = parseInt(match[1], 10);
	const day = parseInt(match[2], 10);
	let year = parseInt(match[3], 10);
	if (year < 100) year += 2000;

	let hours = parseInt(match[4], 10);
	const minutes = parseInt(match[5], 10);
	const ampm = (match[6] || '').toLowerCase();

	if (ampm === 'pm' && hours < 12) {
		hours += 12;
	} else if (ampm === 'am' && hours === 12) {
		hours = 0;
	}

	// Format in ISO UTC (Assuming Turkish Time UTC+3 for Pearson local times)
	// Local time - 3 hours = UTC
	const localDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));
	// Adjust Turkey timezone (+03:00) to UTC:
	const utcTime = new Date(localDate.getTime() - 3 * 60 * 60 * 1000);

	return utcTime.toISOString();
}

/**
 * Parses MyLab Math assignments (table or list view)
 */
export function parseMyLabAssignments(html, metadata = {}) {
	const courseId = metadata.courseId || 5083;
	const courseName = metadata.courseName || '[MATH 119 All Sections] Calculus with Analytic Geometry';
	const results = [];

	if (!html || typeof html !== 'string') return results;

	const $ = cheerio.load(html);

	// Pattern 1: Table-based MyLab view (tr rows)
	$('tr').each((_, row) => {
		const rowText = $(row).text();
		if (!/homework|quiz|test|chapter|preliminaries|continuity|limits/i.test(rowText)) {
			return;
		}

		const anchor = $(row).find('a[href*="PlayerHomework"], a[href*="homeworkId"], a[href*="assignment"]');
		const title = (anchor.text() || $(row).find('.assignment-title, .title, td:nth-child(2)').text()).trim();

		if (!title || title.length < 3) return;

		// Find homework ID
		let homeworkId = null;
		const href = anchor.attr('href') || '';
		const hwMatch = href.match(/homeworkId=(\d+)/i) || href.match(/assignmentId=(\d+)/i);
		if (hwMatch) {
			homeworkId = hwMatch[1];
		} else {
			homeworkId = createHash('md5').update(title).digest('hex').slice(0, 8);
		}

		// Find due date
		let dueAt = null;
		const dateMatch = rowText.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:am|pm)?)/i);
		if (dateMatch) {
			dueAt = parsePearsonDate(dateMatch[1]);
		}

		// Status / Score
		const isCompleted = /100%|complete|submitted|graded/i.test(rowText) && !/incomplete|past due/i.test(rowText);

		results.push({
			id: `assignment:${courseId}:pearson-${homeworkId}`,
			type: 'assignment',
			courseId,
			courseName,
			moduleId: `pearson-${homeworkId}`,
			moduleType: 'pearson',
			title,
			url: href ? (href.startsWith('http') ? href : `https://mylab.pearson.com${href}`) : (metadata.url || ''),
			openAt: null,
			dueAt,
			closeAt: null,
			status: isCompleted ? 'done' : 'todo',
			content: rowText.replace(/\s+/g, ' ').trim(),
			contentHash: createHash('sha256').update(title + (dueAt || '')).digest('hex'),
			event: 'created',
		});
	});

	// Pattern 2: Raw text fallback parsing (like the user-provided format)
	// e.g. "11/10/26 11:59pm Homework CH. 0: Preliminaries, 09/10/26 11:59pm Homework Limit and continuity - basics"
	if (results.length === 0) {
		const text = $.text();
		const regex = /(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:am|pm)?)\s+(Homework[^\n,\r]+)/gi;
		let m;
		while ((m = regex.exec(text)) !== null) {
			const rawDate = m[1].trim();
			const title = m[2].trim();
			const homeworkId = createHash('md5').update(title).digest('hex').slice(0, 8);
			const dueAt = parsePearsonDate(rawDate);

			results.push({
				id: `assignment:${courseId}:pearson-${homeworkId}`,
				type: 'assignment',
				courseId,
				courseName,
				moduleId: `pearson-${homeworkId}`,
				moduleType: 'pearson',
				title,
				url: metadata.url || '',
				openAt: null,
				dueAt,
				closeAt: null,
				status: 'todo',
				content: `${title} - Due: ${rawDate}`,
				contentHash: createHash('sha256').update(title + (dueAt || '')).digest('hex'),
				event: 'created',
			});
		}
	}

	return results;
}

/**
 * Parses MasteringPhysics Course Home assignments widget and list view
 */
export function parseMasteringAssignments(html, metadata = {}) {
	const courseId = metadata.courseId || 4849;
	const courseName = metadata.courseName || '[PHYS 105 ALL SECTIONS] General Physics I';
	const results = [];

	if (!html || typeof html !== 'string') return results;

	const $ = cheerio.load(html);

	// Pattern 1: Assignment items in Mastering Course Home
	$('[data-assignment-id], .assignment-row, .assignment-item, .myct-assignment-card, li').each((_, el) => {
		const text = $(el).text();
		if (!/Introduction to MasteringPhysics|Physics Primer|Mathematics Review|complete|items|due/i.test(text)) {
			return;
		}

		const anchor = $(el).find('a').first();
		const title = (anchor.text() || $(el).find('.title, h4, h5').text()).trim();

		if (!title || title.length < 4 || title.toLowerCase().includes('course home')) return;

		const href = anchor.attr('href') || '';
		const safeId = createHash('md5').update(title).digest('hex').slice(0, 8);

		// Due date
		let dueAt = null;
		const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:am|pm)?)/i);
		if (dateMatch) {
			dueAt = parsePearsonDate(dateMatch[1]);
		}

		// Status
		const isCompleted = /(\d+)\s+of\s+\1\s+complete|completed|100%/i.test(text);

		results.push({
			id: `assignment:${courseId}:pearson-${safeId}`,
			type: 'assignment',
			courseId,
			courseName,
			moduleId: `pearson-${safeId}`,
			moduleType: 'pearson',
			title,
			url: href ? (href.startsWith('http') ? href : `https://session.physics-mastering.pearson.com${href}`) : (metadata.url || ''),
			openAt: null,
			dueAt,
			closeAt: null,
			status: isCompleted ? 'done' : 'todo',
			content: text.replace(/\s+/g, ' ').trim(),
			contentHash: createHash('sha256').update(title + (dueAt || '')).digest('hex'),
			event: 'created',
		});
	});

	// Pattern 2: Text blocks fallback parsing
	// e.g.:
	// [Introduction to MasteringPhysics](...)
	// 12/31/2026 11:59 PM
	// 6 of 6 complete
	if (results.length === 0) {
		const text = $.text();
		const blockRegex = /\[?([A-Za-z0-9\s:_-]+(?:MasteringPhysics|Primer|Review|Homework|Quiz)[^\]\n]*)\]?(?:\([^)]*\))?\s*(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:am|pm)?)\s*([^\n\r]*)/gi;
		let m;
		while ((m = blockRegex.exec(text)) !== null) {
			const title = m[1].replace(/[\[\]]/g, '').trim();
			const rawDate = m[2].trim();
			const extra = m[3] ? m[3].trim() : '';

			const safeId = createHash('md5').update(title).digest('hex').slice(0, 8);
			const dueAt = parsePearsonDate(rawDate);
			const isCompleted = /(\d+)\s+of\s+\1\s+complete/i.test(extra);

			results.push({
				id: `assignment:${courseId}:pearson-${safeId}`,
				type: 'assignment',
				courseId,
				courseName,
				moduleId: `pearson-${safeId}`,
				moduleType: 'pearson',
				title,
				url: metadata.url || '',
				openAt: null,
				dueAt,
				closeAt: null,
				status: isCompleted ? 'done' : 'todo',
				content: `${title} - Due: ${rawDate} (${extra})`,
				contentHash: createHash('sha256').update(title + (dueAt || '')).digest('hex'),
				event: 'created',
			});
		}
	}

	return results;
}

/**
 * Universal dispatcher for Pearson HTML
 */
export function parsePearsonAssignments(html, metadata = {}) {
	if (!html || typeof html !== 'string') return [];

	if (/physics-mastering|masteringphysics|physics primer/i.test(html) || metadata.courseName?.includes('PHYS')) {
		const physResults = parseMasteringAssignments(html, metadata);
		if (physResults.length > 0) return physResults;
	}

	return parseMyLabAssignments(html, metadata);
}
