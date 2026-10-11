import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';

export function derivePearsonSlug(title, fallbackId = null) {
	const t = (title || '').toLowerCase();
	if (/preliminaries|ch\.?\s*0\b/i.test(t)) return 'pearson-ch0';
	if (/limit\s+and\s+continuity.*basics/i.test(t)) return 'pearson-limit-continuity';
	if (/physics\s+primer/i.test(t)) return 'pearson-primer';
	if (/mathematics\s+review/i.test(t)) return 'pearson-math-review';
	if (/introduction\s+to\s+mastering/i.test(t)) return 'pearson-intro';
	if (fallbackId) return `pearson-${fallbackId}`;
	const slug = t
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32);
	return `pearson-${slug || createHash('md5').update(title).digest('hex').slice(0, 8)}`;
}

/**
 * Parses US-style or ISO date strings produced by Pearson platforms:
 * - MyLab: "11/10/26 11:59pm", "09/10/26 11:59pm"
 * - Mastering: "12/31/2026 11:59 PM", "10/15/2026 11:59 PM"
 * - ISO: "2026-10-11T20:59:00Z"
 */
export function parsePearsonDate(rawStr, referenceYear = 2026) {
	if (!rawStr) return null;
	if (typeof rawStr === 'number') {
		const d = new Date(rawStr > 1e11 ? rawStr : rawStr * 1000);
		return Number.isNaN(d.getTime()) ? null : d.toISOString();
	}
	if (typeof rawStr !== 'string') return null;

	const cleaned = rawStr.trim();
	if (!cleaned) return null;

	// Check ISO format first
	if (/^\d{4}-\d{2}-\d{2}T/.test(cleaned)) {
		const d = new Date(cleaned);
		if (!Number.isNaN(d.getTime())) return d.toISOString();
	}

	// Match: Month/Day/Year Time (AM/PM)
	const match = cleaned.match(
		/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i,
	);

	if (!match) {
		const dateOnlyMatch = cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
		if (dateOnlyMatch) {
			const month = parseInt(dateOnlyMatch[1], 10);
			const day = parseInt(dateOnlyMatch[2], 10);
			let year = parseInt(dateOnlyMatch[3], 10);
			if (year < 100) year += 2000;
			const pad = (n) => String(n).padStart(2, '0');
			return `${year}-${pad(month)}-${pad(day)}T20:59:00.000Z`;
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

	const localDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));
	const utcTime = new Date(localDate.getTime() - 3 * 60 * 60 * 1000);

	return utcTime.toISOString();
}

/**
 * Recursively inspects captured Pearson JSON API payloads for assignment arrays/objects
 */
export function parsePearsonApiPayloads(capturedPayloads = [], metadata = {}) {
	const courseId = metadata.courseId || 5083;
	const courseName = metadata.courseName || '';
	const results = [];
	const seenIds = new Set();

	function visit(node) {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}

		const title =
			node.assignmentTitle ||
			node.homeworkTitle ||
			node.title ||
			node.name ||
			node.activityName ||
			node.itemTitle;

		const rawDue =
			node.dueDate ||
			node.dueDateTime ||
			node.dueAt ||
			node.due ||
			node.endDate ||
			node.deadline;

		const rawOpen =
			node.startDate ||
			node.startDateTime ||
			node.openDate ||
			node.availableDate ||
			node.assignedDate ||
			node.openAt ||
			node.start;

		if (
			typeof title === 'string' &&
			title.length >= 3 &&
			(rawDue || rawOpen || node.assignmentId || node.homeworkId)
		) {
			const openAt = parsePearsonDate(rawOpen);
			const dueAt = parsePearsonDate(rawDue);
			const rawStatus = String(
				node.completionStatus ||
					node.status ||
					node.studentStatus ||
					node.submissionStatus ||
					node.state ||
					'',
			).toLowerCase();

			const scorePct =
				typeof node.scorePercentage === 'number'
					? node.scorePercentage
					: typeof node.percentScore === 'number'
						? node.percentScore
						: null;

			const isCompleted =
				node.isCompleted === true ||
				node.completed === true ||
				/complete|completed|submitted|graded|done|100%/i.test(rawStatus) ||
				(scorePct !== null && scorePct >= 99);

			const isInProgress =
				!isCompleted &&
				(/in.?progress|started|incomplete/i.test(rawStatus) ||
					(scorePct !== null && scorePct > 0));

			const status = isCompleted ? 'done' : isInProgress ? 'in-progress' : 'todo';
			const moduleId = derivePearsonSlug(
				title,
				node.homeworkId || node.assignmentId || node.id,
			);
			const fullId = `assignment:${courseId}:${moduleId}`;

			if (!seenIds.has(fullId)) {
				seenIds.add(fullId);
				results.push({
					id: fullId,
					type: 'assignment',
					courseId,
					courseName,
					moduleId,
					moduleType: 'pearson',
					title: title.trim(),
					url: metadata.url || '',
					openAt,
					dueAt,
					closeAt: null,
					status,
					content: `${title.trim()}${openAt ? ` | Start: ${openAt}` : ''}${dueAt ? ` | Due: ${dueAt}` : ''} | Status: ${status}`,
					contentHash: createHash('sha256')
						.update(`${title}|${openAt || ''}|${dueAt || ''}|${status}`)
						.digest('hex'),
					event: 'created',
				});
			}
		}

		for (const val of Object.values(node)) {
			if (val && typeof val === 'object') {
				visit(val);
			}
		}
	}

	for (const entry of capturedPayloads) {
		visit(entry.data);
	}

	return results;
}

/**
 * Parses MyLab Math assignments (table or list view)
 */
export function parseMyLabAssignments(html, metadata = {}) {
	const courseId = metadata.courseId || 5083;
	const courseName =
		metadata.courseName || '[MATH 119 All Sections] Calculus with Analytic Geometry';
	const results = [];

	if (!html || typeof html !== 'string') return results;

	const $ = cheerio.load(html);

	$('tr').each((_, row) => {
		const rowText = $(row).text();
		if (!/homework|quiz|test|chapter|preliminaries|continuity|limits/i.test(rowText)) {
			return;
		}

		const anchor = $(row).find(
			'a[href*="PlayerHomework"], a[href*="homeworkId"], a[href*="assignment"]',
		);
		const title = (
			anchor.text() || $(row).find('.assignment-title, .title, td:nth-child(2)').text()
		).trim();

		if (!title || title.length < 3) return;

		let homeworkId = null;
		const href = anchor.attr('href') || '';
		const hwMatch =
			href.match(/homeworkId=(\d+)/i) || href.match(/assignmentId=(\d+)/i);
		if (hwMatch) {
			homeworkId = hwMatch[1];
		}

		// Extract all dates in the row (if 2 dates exist, first is typically Start/Assigned, second is Due)
		const dateMatches = [
			...rowText.matchAll(
				/(\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:am|pm)?)?)/gi,
			),
		].map((m) => m[1]);

		let openAt = null;
		let dueAt = null;
		if (dateMatches.length >= 2) {
			openAt = parsePearsonDate(dateMatches[0]);
			dueAt = parsePearsonDate(dateMatches[1]);
		} else if (dateMatches.length === 1) {
			dueAt = parsePearsonDate(dateMatches[0]);
		}

		const isCompleted =
			/100%|complete|completed|submitted|graded/i.test(rowText) &&
			!/incomplete|0%/i.test(rowText);
		const isInProgress =
			!isCompleted && /\b([1-9]\d?)%\b|in\s+progress/i.test(rowText);
		const status = isCompleted ? 'done' : isInProgress ? 'in-progress' : 'todo';
		const moduleId = derivePearsonSlug(title, homeworkId);

		results.push({
			id: `assignment:${courseId}:${moduleId}`,
			type: 'assignment',
			courseId,
			courseName,
			moduleId,
			moduleType: 'pearson',
			title,
			url: href
				? href.startsWith('http')
					? href
					: `https://mylab.pearson.com${href}`
				: metadata.url || '',
			openAt,
			dueAt,
			closeAt: null,
			status,
			content: rowText.replace(/\s+/g, ' ').trim(),
			contentHash: createHash('sha256')
				.update(`${title}|${openAt || ''}|${dueAt || ''}|${status}`)
				.digest('hex'),
			event: 'created',
		});
	});

	if (results.length === 0) {
		const text = $.text();
		const regex =
			/(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:am|pm)?)\s+(Homework[^\n,\r]+)/gi;
		let m;
		while ((m = regex.exec(text)) !== null) {
			const rawDate = m[1].trim();
			const title = m[2].trim();
			const moduleId = derivePearsonSlug(title);
			const dueAt = parsePearsonDate(rawDate);

			results.push({
				id: `assignment:${courseId}:${moduleId}`,
				type: 'assignment',
				courseId,
				courseName,
				moduleId,
				moduleType: 'pearson',
				title,
				url: metadata.url || '',
				openAt: null,
				dueAt,
				closeAt: null,
				status: 'todo',
				content: `${title} - Due: ${rawDate}`,
				contentHash: createHash('sha256')
					.update(`${title}|${dueAt || ''}|todo`)
					.digest('hex'),
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
	const courseName =
		metadata.courseName || '[PHYS 105 ALL SECTIONS] General Physics I';
	const results = [];

	if (!html || typeof html !== 'string') return results;

	const $ = cheerio.load(html);

	$(
		'[data-assignment-id], .assignment-row, .assignment-item, .myct-assignment-card, tr, li',
	).each((_, el) => {
		const text = $(el).text();
		if (
			!/Introduction to MasteringPhysics|Physics Primer|Mathematics Review|complete|items|due|homework|ch\s*\d/i.test(
				text,
			)
		) {
			return;
		}

		const anchor = $(el).find('a').first();
		const title = (anchor.text() || $(el).find('.title, h4, h5').text()).trim();

		if (
			!title ||
			title.length < 4 ||
			/course home|scores|etext|study area/i.test(title)
		) {
			return;
		}

		const href = anchor.attr('href') || '';
		const moduleId = derivePearsonSlug(title);

		const dateMatches = [
			...text.matchAll(
				/(\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:am|pm)?)?)/gi,
			),
		].map((m) => m[1]);

		let openAt = null;
		let dueAt = null;
		if (dateMatches.length >= 2) {
			openAt = parsePearsonDate(dateMatches[0]);
			dueAt = parsePearsonDate(dateMatches[1]);
		} else if (dateMatches.length === 1) {
			dueAt = parsePearsonDate(dateMatches[0]);
		}

		const isCompleted = /(\d+)\s+of\s+\1\s+complete|completed|100%/i.test(text);
		const partialMatch = text.match(/(\d+)\s+of\s+(\d+)\s+complete/i);
		const isInProgress =
			!isCompleted &&
			partialMatch &&
			parseInt(partialMatch[1], 10) > 0 &&
			parseInt(partialMatch[1], 10) < parseInt(partialMatch[2], 10);
		const status = isCompleted ? 'done' : isInProgress ? 'in-progress' : 'todo';

		if (results.some((r) => r.id === `assignment:${courseId}:${moduleId}`)) {
			return;
		}

		results.push({
			id: `assignment:${courseId}:${moduleId}`,
			type: 'assignment',
			courseId,
			courseName,
			moduleId,
			moduleType: 'pearson',
			title,
			url: href
				? href.startsWith('http')
					? href
					: `https://session.physics-mastering.pearson.com${href}`
				: metadata.url || '',
			openAt,
			dueAt,
			closeAt: null,
			status,
			content: text.replace(/\s+/g, ' ').trim(),
			contentHash: createHash('sha256')
				.update(`${title}|${openAt || ''}|${dueAt || ''}|${status}`)
				.digest('hex'),
			event: 'created',
		});
	});

	if (results.length === 0) {
		const text = $.text();
		const blockRegex =
			/\[?([A-Za-z0-9\s:_-]+(?:MasteringPhysics|Primer|Review|Homework|Quiz)[^\]\n]*)\]?(?:\([^)]*\))?\s*(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:am|pm)?)\s*([^\n\r]*)/gi;
		let m;
		while ((m = blockRegex.exec(text)) !== null) {
			const title = m[1].replace(/[\[\]]/g, '').trim();
			const rawDate = m[2].trim();
			const extra = m[3] ? m[3].trim() : '';

			const moduleId = derivePearsonSlug(title);
			const dueAt = parsePearsonDate(rawDate);
			const isCompleted = /(\d+)\s+of\s+\1\s+complete/i.test(extra);
			const status = isCompleted ? 'done' : 'todo';

			results.push({
				id: `assignment:${courseId}:${moduleId}`,
				type: 'assignment',
				courseId,
				courseName,
				moduleId,
				moduleType: 'pearson',
				title,
				url: metadata.url || '',
				openAt: null,
				dueAt,
				closeAt: null,
				status,
				content: `${title} - Due: ${rawDate} (${extra})`,
				contentHash: createHash('sha256')
					.update(`${title}|${dueAt || ''}|${status}`)
					.digest('hex'),
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

	if (
		/physics-mastering|masteringphysics|physics primer/i.test(html) ||
		metadata.courseName?.includes('PHYS')
	) {
		const physResults = parseMasteringAssignments(html, metadata);
		if (physResults.length > 0) return physResults;
	}

	return parseMyLabAssignments(html, metadata);
}
