import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';

export function derivePearsonSlug(title, fallbackId = null) {
	const t = (title || '')
		.toLowerCase()
		.replace(/^(?:homework|quiz|test)\s*:\s*/i, '')
		.trim();
	if (/preliminaries|ch\.?\s*0\b/i.test(t)) return 'pearson-ch0';
	if (/limit\s+and\s+continuity.*basics/i.test(t)) return 'pearson-limit-continuity';
	if (/formal\s+definitions.*differentiation/i.test(t)) return 'pearson-formal-definitions';
	if (/physics\s+primer/i.test(t)) return 'pearson-primer';
	if (/mathematics\s+review/i.test(t)) return 'pearson-math-review';
	if (/introduction\s+to\s+mastering/i.test(t)) return 'pearson-intro';
	const slug = t
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32)
		.replace(/-+$/g, '');
	if (slug) return `pearson-${slug}`;
	if (fallbackId) return `pearson-${fallbackId}`;
	return `pearson-${createHash('md5').update(title || '').digest('hex').slice(0, 8)}`;
}

const MONTH_MAP = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

/**
 * Parses US-style, EU-style, month-name, array, or ISO date strings produced by Pearson platforms:
 * - Array (Mastering): ["2026", "12", "31", "23", "59", "00"]
 * - ISO (MyLab API): "2026-10-03T09:00:00", "2026-10-11T23:59:00"
 * - Month Name (MyLab Frame): "OCT 3", "OCT 11 11:59 PM"
 * - Mastering: "12/31/2026 11:59 PM"
 * - MyLab DoAssignments: "11/10/26 11:59pm" (DD/MM/YY when 2-digit year)
 */
export function parsePearsonDate(rawStr, referenceYear = 2026, opts = {}) {
	if (!rawStr) return null;

	// Handle Mastering date array: ["2026", "12", "31", "23", "59", "00"]
	if (Array.isArray(rawStr) && rawStr.length >= 3) {
		const year = parseInt(rawStr[0], 10);
		const month = parseInt(rawStr[1], 10);
		const day = parseInt(rawStr[2], 10);
		const hours = rawStr[3] !== undefined ? parseInt(rawStr[3], 10) : 23;
		const minutes = rawStr[4] !== undefined ? parseInt(rawStr[4], 10) : 59;
		if (!Number.isNaN(year) && !Number.isNaN(month) && !Number.isNaN(day)) {
			const localDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));
			const utcTime = new Date(localDate.getTime() - 3 * 60 * 60 * 1000);
			return utcTime.toISOString();
		}
		return null;
	}

	if (typeof rawStr === 'number') {
		const d = new Date(rawStr > 1e11 ? rawStr : rawStr * 1000);
		return Number.isNaN(d.getTime()) ? null : d.toISOString();
	}
	if (typeof rawStr !== 'string') return null;

	const cleaned = rawStr.trim();
	if (!cleaned || cleaned.startsWith('0001-01-01')) return null;

	// Check ISO format first
	if (/^\d{4}-\d{2}-\d{2}T/.test(cleaned)) {
		const hasTz = /Z$|[+-]\d{2}:?\d{2}$/i.test(cleaned);
		const isoWithTz = hasTz ? cleaned : `${cleaned}+03:00`;
		const d = new Date(isoWithTz);
		if (!Number.isNaN(d.getTime())) return d.toISOString();
	}

	// Check Month-Name format: "OCT 3" or "OCT 11 11:59 PM"
	const monthNameMatch = cleaned.match(
		/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+(\d{1,2})(?:\s+(?:,\s*(\d{4})\s*)?(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?)?/i,
	);
	if (monthNameMatch) {
		const month = MONTH_MAP[monthNameMatch[1].slice(0, 3).toLowerCase()];
		const day = parseInt(monthNameMatch[2], 10);
		const year = monthNameMatch[3] ? parseInt(monthNameMatch[3], 10) : referenceYear;
		let hours = monthNameMatch[4] !== undefined ? parseInt(monthNameMatch[4], 10) : 9;
		const minutes = monthNameMatch[5] !== undefined ? parseInt(monthNameMatch[5], 10) : 0;
		const ampm = (monthNameMatch[6] || '').toLowerCase();
		if (ampm === 'pm' && hours < 12) hours += 12;
		else if (ampm === 'am' && hours === 12) hours = 0;

		const localDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));
		const utcTime = new Date(localDate.getTime() - 3 * 60 * 60 * 1000);
		return utcTime.toISOString();
	}

	// Match numeric slash date: M/D/YYYY or D/M/YY with optional time
	const match = cleaned.match(
		/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?)?/i,
	);
	if (!match) return null;

	const firstNum = parseInt(match[1], 10);
	const secondNum = parseInt(match[2], 10);
	const rawYear = match[3];
	let year = parseInt(rawYear, 10);
	if (year < 100) year += 2000;

	let month;
	let day;
	if (firstNum > 12) {
		day = firstNum;
		month = secondNum;
	} else if (secondNum > 12) {
		month = firstNum;
		day = secondNum;
	} else if (opts.dayFirst || rawYear.length === 2) {
		// MyLab DoAssignments.aspx uses 2-digit year with DD/MM/YY (e.g. 11/10/26 = Oct 11, 2026)
		day = firstNum;
		month = secondNum;
	} else {
		month = firstNum;
		day = secondNum;
	}

	let hours = match[4] !== undefined ? parseInt(match[4], 10) : 23;
	const minutes = match[5] !== undefined ? parseInt(match[5], 10) : 59;
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

export function mergePearsonAssignmentLists(...lists) {
	const byId = new Map();
	const rank = { todo: 0, 'in-progress': 1, done: 2 };

	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (!item || !item.id) continue;
			const existing = byId.get(item.id);
			if (!existing) {
				byId.set(item.id, { ...item });
			} else {
				const openAt = existing.openAt || item.openAt || null;
				const dueAt = existing.dueAt || item.dueAt || null;
				const status =
					(rank[item.status] ?? 0) > (rank[existing.status] ?? 0)
						? item.status
						: existing.status;
				const title =
					existing.title && existing.title.startsWith('Homework:')
						? existing.title
						: item.title && item.title.startsWith('Homework:')
							? item.title
							: existing.title || item.title;
				const content =
					(item.content || '').length > (existing.content || '').length
						? item.content
						: existing.content;
				const merged = {
					...existing,
					title,
					openAt,
					dueAt,
					status,
					content,
				};
				merged.contentHash = createHash('sha256')
					.update(`${merged.title}|${merged.openAt || ''}|${merged.dueAt || ''}|${merged.status}`)
					.digest('hex');
				byId.set(item.id, merged);
			}
		}
	}

	return Array.from(byId.values());
}

/**
 * Recursively inspects captured Pearson JSON API payloads for assignment arrays/objects
 */
export function parsePearsonApiPayloads(capturedPayloads = [], metadata = {}) {
	const courseId = metadata.courseId || 5083;
	const courseName = metadata.courseName || '';
	const results = [];

	// Pre-scan payloads for courseStartDate and Mastering grade map (id -> { percentage, score })
	let courseStartDate = null;
	const gradeById = new Map();

	function preScan(node) {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const item of node) preScan(item);
			return;
		}
		if (typeof node.courseStartDate === 'string' && !courseStartDate) {
			const parsed = parsePearsonDate(node.courseStartDate);
			if (parsed) courseStartDate = parsed;
		}
		if (node.id && (node.percentage !== undefined || node.score !== undefined)) {
			gradeById.set(String(node.id), {
				percentage: node.percentage,
				score: node.score,
			});
		}
		for (const val of Object.values(node)) {
			if (val && typeof val === 'object') preScan(val);
		}
	}

	for (const entry of capturedPayloads) {
		preScan(entry.data);
	}

	function visit(node) {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}

		// Must look like an actual assignment object (not a Pendo guide, nav link, or course section)
		const hasAssignmentId =
			node.assignmentId !== undefined ||
			node.assignmentID !== undefined ||
			node.homeworkId !== undefined ||
			Array.isArray(node.dateDueArray) ||
			typeof node.gradeCategoryString === 'string';

		if (!hasAssignmentId) {
			for (const val of Object.values(node)) {
				if (val && typeof val === 'object') visit(val);
			}
			return;
		}

		const rawTitle =
			node.assignmentName ||
			node.assignmentTitle ||
			node.homeworkTitle ||
			node.title ||
			node.name ||
			node.activityName ||
			node.itemTitle;

		if (typeof rawTitle === 'string' && rawTitle.trim().length >= 3) {
			let title = rawTitle.trim();
			if (
				typeof node.gradeCategoryString === 'string' &&
				/homework/i.test(node.gradeCategoryString) &&
				!/^homework/i.test(title)
			) {
				title = `Homework: ${title}`;
			}

			const rawDue =
				node.endDate ||
				node.dueDate ||
				node.dueDateTime ||
				node.dateDueArray ||
				node.dueAt ||
				node.due ||
				node.deadline;

			const rawOpen =
				node.startDate ||
				node.displayDate ||
				node.startDateTime ||
				node.openDate ||
				node.availableDate ||
				node.assignedDate ||
				node.dateAvailableArray ||
				node.dateAssignedArray ||
				node.dateFromArray ||
				node.openAt ||
				node.start;

			const openAt = parsePearsonDate(rawOpen) || courseStartDate || null;
			const dueAt = parsePearsonDate(rawDue);

			const rawId =
				node.homeworkId || node.assignmentId || node.assignmentID || node.id;
			const gradeInfo = rawId ? gradeById.get(String(rawId)) : null;

			const rawStatus = String(
				node.completionStatus ||
					node.status ||
					node.studentStatus ||
					node.submissionStatus ||
					node.state ||
					gradeInfo?.percentage ||
					'',
			).toLowerCase();

			let scorePct = null;
			const numericScoreFields = [
				node.scorePercentage,
				node.percentScore,
				node.score,
				node.rawScore,
				node.bestScore,
				node.studentScore,
				node.grade,
			];
			for (const sf of numericScoreFields) {
				if (typeof sf === 'number' && !Number.isNaN(sf)) {
					scorePct = sf <= 1 && sf > 0 ? sf * 100 : sf;
					break;
				}
				if (typeof sf === 'string') {
					const m = sf.match(/(\d+(?:\.\d+)?)\s*%/);
					if (m) {
						scorePct = parseFloat(m[1]);
						break;
					}
				}
			}
			if (scorePct === null && gradeInfo?.percentage) {
				const m = String(gradeInfo.percentage).match(/(\d+(?:\.\d+)?)/);
				if (m) scorePct = parseFloat(m[1]);
			}

			const allItemsDone =
				(typeof node.problemCount === 'number' &&
					node.problemCount > 0 &&
					node.problemCompletedCount >= node.problemCount) ||
				(typeof node.totalQuestions === 'number' &&
					node.totalQuestions > 0 &&
					(node.questionsCompleted >= node.totalQuestions ||
						node.completedQuestions >= node.totalQuestions)) ||
				(typeof node.totalItems === 'number' &&
					node.totalItems > 0 &&
					node.completedItems >= node.totalItems) ||
				(typeof node.itemsLeft === 'number' &&
					node.itemsLeft === 0 &&
					node.problemCount > 0) ||
				(node.timeEstimate &&
					String(node.timeEstimate.itemsLeft) === '0' &&
					node.problemCount > 0);

			const isCompleted =
				node.isComplete === 1 ||
				node.isComplete === true ||
				node.isCompleted === true ||
				node.completed === true ||
				allItemsDone ||
				/complete|completed|submitted|graded|done|100%/i.test(rawStatus) ||
				(scorePct !== null && scorePct >= 90);

			const isInProgress =
				!isCompleted &&
				(node.isAttemptStarted === 1 ||
					node.isAttemptStarted === true ||
					(typeof node.problemCompletedCount === 'number' &&
						node.problemCompletedCount > 0) ||
					/in.?progress|started|incomplete/i.test(rawStatus) ||
					(scorePct !== null && scorePct > 0));

			const status = isCompleted ? 'done' : isInProgress ? 'in-progress' : 'todo';
			const moduleId = derivePearsonSlug(title, rawId);
			const fullId = `assignment:${courseId}:${moduleId}`;

			results.push({
				id: fullId,
				type: 'assignment',
				courseId,
				courseName,
				moduleId,
				moduleType: 'pearson',
				title,
				url: metadata.url || '',
				openAt,
				dueAt,
				closeAt: null,
				status,
				content: `${title}${openAt ? ` | Start: ${openAt}` : ''}${dueAt ? ` | Due: ${dueAt}` : ''} | Status: ${status}`,
				contentHash: createHash('sha256')
					.update(`${title}|${openAt || ''}|${dueAt || ''}|${status}`)
					.digest('hex'),
				event: 'created',
			});
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

	return mergePearsonAssignmentLists(results);
}

/**
 * Parses MyLab Math assignments from HTML and rendered innerText
 * Supports:
 * 1. MyLab Student Home (`pagelink=frame`):
 *    "OCT 3 Limit and continuity - basics DUE OCT 11 11:59 PM Score: 96.67% 30 of 30"
 * 2. MyLab Homework and Tests (`DoAssignments.aspx?view=all`):
 *    "11/10/26 11:59pm Homework CH. 0: Preliminaries see score for CH. 0: Preliminaries"
 */
export function parseMyLabAssignments(html, metadata = {}, frameText = '') {
	const courseId = metadata.courseId || 5083;
	const courseName =
		metadata.courseName || '[MATH 119 All Sections] Calculus with Analytic Geometry';
	const results = [];

	const combinedText = `${frameText || ''}\n${
		html && typeof html === 'string'
			? cheerio
					.load(html)('body')
					.text()
					.replace(/\s+/g, ' ')
			: ''
	}`;

	// Pattern 1: MyLab Student Home card text
	// e.g. "OCT 3 Limit and continuity - basics DUE OCT 11 11:59 PM Score: 96.67% 30 of 30"
	const homeRegex =
		/\b((?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+\d{1,2})\s+([^\n\r]+?)\s+DUE\s+((?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+\d{1,2}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)(?:\s+Score:\s*([\d.]+)%?(?:\s+(\d+)\s+of\s+(\d+))?)?/gi;
	let hm;
	while ((hm = homeRegex.exec(combinedText)) !== null) {
		const rawStart = hm[1].trim();
		const rawTitle = hm[2].trim();
		const rawDue = hm[3].trim();
		const scorePct = hm[4] !== undefined ? parseFloat(hm[4]) : null;
		const doneItems = hm[5] !== undefined ? parseInt(hm[5], 10) : null;
		const totalItems = hm[6] !== undefined ? parseInt(hm[6], 10) : null;

		const title = /^homework/i.test(rawTitle) ? rawTitle : `Homework: ${rawTitle}`;
		const openAt = parsePearsonDate(rawStart);
		const dueAt = parsePearsonDate(rawDue);
		const isDone =
			(doneItems !== null && totalItems !== null && totalItems > 0 && doneItems >= totalItems) ||
			(scorePct !== null && scorePct >= 90);
		const isInProgress =
			!isDone && ((doneItems !== null && doneItems > 0) || (scorePct !== null && scorePct > 0));
		const status = isDone ? 'done' : isInProgress ? 'in-progress' : 'todo';
		const moduleId = derivePearsonSlug(title);

		results.push({
			id: `assignment:${courseId}:${moduleId}`,
			type: 'assignment',
			courseId,
			courseName,
			moduleId,
			moduleType: 'pearson',
			title,
			url: metadata.url || '',
			openAt,
			dueAt,
			closeAt: null,
			status,
			content: hm[0].replace(/\s+/g, ' ').trim(),
			contentHash: createHash('sha256')
				.update(`${title}|${openAt || ''}|${dueAt || ''}|${status}`)
				.digest('hex'),
			event: 'created',
		});
	}

	// Pattern 2: DoAssignments.aspx text
	// e.g. "11/10/26 11:59pm Homework CH. 0: Preliminaries see score for CH. 0: Preliminaries"
	const doAssignRegex =
		/(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:am|pm)?)\s+Homework\s+([^\n\r]+?)(?=\s+see\s+score\s+for|\s+\d{1,2}\/\d{1,2}\/\d{2,4}|\s+This\s+course|$)/gi;
	let dm;
	while ((dm = doAssignRegex.exec(combinedText)) !== null) {
		const rawDue = dm[1].trim();
		const rawTitle = dm[2].trim();
		const title = /^homework/i.test(rawTitle) ? rawTitle : `Homework: ${rawTitle}`;
		const dueAt = parsePearsonDate(rawDue, 2026, { dayFirst: true });
		const afterSlice = combinedText.slice(dm.index, dm.index + dm[0].length + 80);
		const hasScore = /see\s+score\s+for/i.test(afterSlice);
		const status = hasScore ? 'done' : 'todo';
		const moduleId = derivePearsonSlug(title);

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
			content: dm[0].replace(/\s+/g, ' ').trim(),
			contentHash: createHash('sha256')
				.update(`${title}|${dueAt || ''}|${status}`)
				.digest('hex'),
			event: 'created',
		});
	}

	if (html && typeof html === 'string') {
		const $ = cheerio.load(html);
		$('tr').each((_, row) => {
			const rowText = $(row).text().replace(/\s+/g, ' ').trim();
			if (!/homework|quiz|test|preliminaries|continuity|limits/i.test(rowText)) {
				return;
			}
			if (/due\s+assignment\s+time\s+limit/i.test(rowText)) return;

			const anchor = $(row)
				.find('th a, td a')
				.filter((__, a) => !/see\s+score/i.test($(a).text()))
				.first();
			const rawTitle = (anchor.text() || '').trim();
			if (!rawTitle || rawTitle.length < 3) return;

			const title = /^homework/i.test(rawTitle) ? rawTitle : `Homework: ${rawTitle}`;
			const dateMatches = [
				...rowText.matchAll(
					/(\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:am|pm)?)?)/gi,
				),
			].map((m) => m[1]);

			let openAt = null;
			let dueAt = null;
			if (dateMatches.length >= 2) {
				openAt = parsePearsonDate(dateMatches[0], 2026, { dayFirst: true });
				dueAt = parsePearsonDate(dateMatches[1], 2026, { dayFirst: true });
			} else if (dateMatches.length === 1) {
				dueAt = parsePearsonDate(dateMatches[0], 2026, { dayFirst: true });
			}

			const isCompleted =
				/100%|complete|completed|submitted|graded|see\s+score\s+for/i.test(rowText) &&
				!/incomplete|0%/i.test(rowText);
			const isInProgress =
				!isCompleted && /\b([1-9]\d?)%\b|in\s+progress/i.test(rowText);
			const status = isCompleted ? 'done' : isInProgress ? 'in-progress' : 'todo';
			const moduleId = derivePearsonSlug(title);

			results.push({
				id: `assignment:${courseId}:${moduleId}`,
				type: 'assignment',
				courseId,
				courseName,
				moduleId,
				moduleType: 'pearson',
				title,
				url: metadata.url || '',
				openAt,
				dueAt,
				closeAt: null,
				status,
				content: rowText,
				contentHash: createHash('sha256')
					.update(`${title}|${openAt || ''}|${dueAt || ''}|${status}`)
					.digest('hex'),
				event: 'created',
			});
		});
	}

	return mergePearsonAssignmentLists(results);
}

/**
 * Parses MasteringPhysics Course Home assignments widget and list view
 */
export function parseMasteringAssignments(html, metadata = {}, frameText = '') {
	const courseId = metadata.courseId || 4849;
	const courseName =
		metadata.courseName || '[PHYS 105 ALL SECTIONS] General Physics I';
	const results = [];

	if (!html || typeof html !== 'string') return results;

	const $ = cheerio.load(html);

	$(
		'[data-assignment-id], .assignment-row, .assignment-item, .myct-assignment-card, tr, li',
	).each((_, el) => {
		const text = $(el).text().replace(/\s+/g, ' ').trim();
		if (
			!/Introduction to MasteringPhysics|Physics Primer|Mathematics Review|complete|items|due|homework|ch\s*\d/i.test(
				text,
			)
		) {
			return;
		}

		// Exclude announcement rows and "Coming up soon" hero banner
		if (
			/^coming up soon|^welcome back/i.test(text) ||
			$(el).is('[id*="announcement"], [class*="announcement"]') ||
			$(el).closest('[id*="announcement"], [class*="announcement"]').length > 0
		) {
			return;
		}

		const anchor = $(el).find('a').first();
		const href = anchor.attr('href') || '';
		if (href.includes('announcement')) return;

		const title = (anchor.text() || $(el).find('.title, h4, h5').text()).trim();

		if (
			!title ||
			title.length < 4 ||
			/course home|scores|etext|study area|online homework|\bnew$|^announcements?\b|^coming up soon/i.test(
				title,
			)
		) {
			return;
		}

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

		results.push({
			id: `assignment:${courseId}:${moduleId}`,
			type: 'assignment',
			courseId,
			courseName,
			moduleId,
			moduleType: 'pearson',
			title,
			url: metadata.url || '',
			openAt,
			dueAt,
			closeAt: null,
			status,
			content: text,
			contentHash: createHash('sha256')
				.update(`${title}|${openAt || ''}|${dueAt || ''}|${status}`)
				.digest('hex'),
			event: 'created',
		});
	});

	return mergePearsonAssignmentLists(results);
}

/**
 * Universal dispatcher for Pearson HTML
 */
export function parsePearsonAssignments(html, metadata = {}, frameText = '') {
	if ((!html || typeof html !== 'string') && !frameText) return [];

	if (
		/physics-mastering|masteringphysics|physics primer/i.test(html || '') ||
		metadata.courseName?.includes('PHYS')
	) {
		const physResults = parseMasteringAssignments(html, metadata, frameText);
		if (physResults.length > 0) return physResults;
	}

	return parseMyLabAssignments(html, metadata, frameText);
}
