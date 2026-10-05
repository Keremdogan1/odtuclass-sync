import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';

const MONTH_NAMES = {
	january: 1,
	february: 2,
	march: 3,
	april: 4,
	may: 5,
	june: 6,
	july: 7,
	august: 8,
	september: 9,
	october: 10,
	november: 11,
	december: 12,
};

export function parseWeekDates(sectionName, referenceYear = 2026) {
	if (!sectionName || typeof sectionName !== 'string') {
		return { weekStart: null, weekEnd: null };
	}

	const match = sectionName.match(
		/([a-zA-Z]+)\s+(\d{1,2})\s*[-–—]\s*(?:([a-zA-Z]+)\s+)?(\d{1,2})/,
	);

	if (!match) {
		return { weekStart: null, weekEnd: null };
	}

	const startMonthStr = match[1].toLowerCase();
	const startDay = parseInt(match[2], 10);
	const endMonthStr = match[3] ? match[3].toLowerCase() : startMonthStr;
	const endDay = parseInt(match[4], 10);

	const startMonth = MONTH_NAMES[startMonthStr];
	const endMonth = MONTH_NAMES[endMonthStr];

	if (!startMonth || !endMonth) {
		return { weekStart: null, weekEnd: null };
	}

	let startYear = referenceYear;
	let endYear = referenceYear;

	if (startMonth <= 2) {
		startYear = referenceYear + 1;
	}

	if (endMonth <= 2 && startMonth >= 9) {
		endYear = referenceYear + 1;
	} else if (endMonth < startMonth) {
		endYear = referenceYear + 1;
	}

	const pad = (n) => String(n).padStart(2, '0');

	return {
		weekStart: `${startYear}-${pad(startMonth)}-${pad(startDay)}`,
		weekEnd: `${endYear}-${pad(endMonth)}-${pad(endDay)}`,
	};
}

export function normalizeSectionHtml(rawHtml) {
	if (!rawHtml || typeof rawHtml !== 'string') {
		return '';
	}

	const $ = cheerio.load(rawHtml);

	// Convert <br> to newline
	$('br').replaceWith('\n');

	// Convert <li> to list item with "- "
	$('li').each((_, li) => {
		const text = $(li).text().trim();
		$(li).replaceWith(`- ${text}\n`);
	});

	// Append newline to block elements
	$('p, h1, h2, h3, h4, h5, h6, ul, ol').each((_, block) => {
		$(block).prepend('\n').append('\n');
	});

	// Extract text
	let text = $.text();

	// Normalize non-breaking spaces (\u00a0) and other special spaces
	text = text.replace(/[\u00a0\u2000-\u200b\u202f\u205f]/g, ' ');

	// Split by newline and trim each line
	const lines = text
		.split('\n')
		.map((line) => line.trim());

	// Filter out excess blank lines (max 1 empty line between blocks)
	const cleanLines = [];
	let previousWasEmpty = true;

	for (const line of lines) {
		if (line.length === 0) {
			if (!previousWasEmpty) {
				cleanLines.push('');
				previousWasEmpty = true;
			}
		} else {
			cleanLines.push(line);
			previousWasEmpty = false;
		}
	}

	return cleanLines.join('\n').trim();
}

export function computeContentHash(cleanText) {
	if (!cleanText || typeof cleanText !== 'string' || cleanText.trim().length === 0) {
		return null;
	}

	return createHash('sha256').update(cleanText, 'utf8').digest('hex');
}

export function extractSectionId(url) {
	try {
		const parsed = new URL(url);
		const id = parsed.searchParams.get('id');
		return id ? Number(id) : null;
	} catch {
		return null;
	}
}

export async function getCourseSections(client, course) {
	const response = await client.request(
		'GET',
		`${client.baseUrl}/course/view.php?id=${course.id}`,
	);

	const $ = cheerio.load(response.data);
	const sections = [];

	$('li.section').each((_, element) => {
		const sec = $(element);

		const link = sec.find('a[href*="section.php"]').first();
		if (!link.length) {
			return;
		}

		const name = link.text().trim();
		const url = link.attr('href') || '';
		const sectionId = extractSectionId(url);

		if (!sectionId) {
			return;
		}

		const summaryEl = sec
			.find(
				'.summarytext .no-overflow, .content > .summary .no-overflow, .summary .no-overflow',
			)
			.first();
		const rawHtml = summaryEl.html() || '';

		const content = normalizeSectionHtml(rawHtml);

		// Ignore empty sections (whitespace-only or empty)
		if (!content || content.length === 0) {
			return;
		}

		const contentHash = computeContentHash(content);
		const { weekStart, weekEnd } = parseWeekDates(name, client.year || 2026);

		sections.push({
			id: `section:${course.id}:${sectionId}`,
			type: 'section',
			courseId: course.id,
			courseName: course.fullname,
			sectionId,
			title: name,
			name,
			url,
			content,
			contentHash,
			weekStart,
			weekEnd,
		});
	});

	return sections;
}
