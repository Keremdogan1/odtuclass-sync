import { PDFParse } from 'pdf-parse';
import { createHash } from 'node:crypto';

export const DEFAULT_SEMESTER_START = '2026-09-28';

export async function extractPdfText(buffer) {
	if (!buffer) {
		throw new Error('Buffer is required for PDF text extraction.');
	}

	const uint8Array = Buffer.isBuffer(buffer)
		? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
		: buffer instanceof Uint8Array
			? buffer
			: new Uint8Array(buffer);
	const parser = new PDFParse(uint8Array);
	const result = await parser.getText();
	return result.text || '';
}

export function parseTokensToNumbers(rawText) {
	if (!rawText || rawText === '—' || rawText === '-') {
		return [];
	}

	const results = [];
	const tokens = rawText
		.split(/[,;]+/)
		.map((t) => t.trim())
		.filter(Boolean);

	for (const token of tokens) {
		const rangeMatch = token.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
		if (rangeMatch) {
			const start = parseInt(rangeMatch[1], 10);
			const end = parseInt(rangeMatch[2], 10);
			for (let i = start; i <= end; i++) {
				results.push(String(i));
			}
		} else if (/^\d+$/.test(token)) {
			results.push(token);
		}
	}

	return results;
}

export function parseChapterProblemsPdf(pdfText, metadata = {}, semesterStart = DEFAULT_SEMESTER_START) {
	const courseId = metadata.courseId || extractCourseIdFromText(pdfText) || '0';
	const courseName = metadata.courseName || extractCourseNameFromText(pdfText) || 'Course';

	const chapterRegex = /Chapter\s+(\d+)\.\s*([^\n\r]+)([\s\S]*?)(?=Chapter\s+\d+\.|$)/gi;
	const chapters = [];
	let match;

	while ((match = chapterRegex.exec(pdfText)) !== null) {
		const chapNum = parseInt(match[1], 10);
		const chapTitle = match[2].trim();
		const body = match[3];

		// Selected problems
		let problems = [];
		const probMatch = body.match(/(?:selected|suggested|recommended)\s+problems\s*:\s*([^\n\r]+)/i);
		if (probMatch) {
			problems = parseTokensToNumbers(probMatch[1].trim());
		}

		// Topics
		const topics = [];
		for (const line of body.split('\n')) {
			const trimmed = line.trim();
			if (/^[•\-\*]?\s*\d+[-.]\d+/.test(trimmed)) {
				topics.push(trimmed.replace(/^[•\-\*]?\s*/, ''));
			}
		}

		// Course coverage
		const coverageMatch = body.match(/Course\s+coverage\s*:\s*([^\n\r]+)/i);
		const coverage = coverageMatch ? coverageMatch[1].trim() : '';

		chapters.push({
			chapter: chapNum,
			title: chapTitle,
			topics,
			coverage,
			problems,
			rawBody: body.trim(),
		});
	}

	chapters.sort((a, b) => a.chapter - b.chapter);

	const baseDate = new Date(`${semesterStart}T00:00:00Z`);
	const pad = (n) => String(n).padStart(2, '0');
	const formatDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	const formatLabel = (d1, d2) => {
		const m1 = d1.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
		const m2 = d2.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
		if (m1 === m2) {
			return `${m1} ${pad(d1.getUTCDate())} - ${pad(d2.getUTCDate())}`;
		}
		return `${m1} ${pad(d1.getUTCDate())} - ${m2} ${pad(d2.getUTCDate())}`;
	};

	const sections = [];
	for (const item of chapters) {
		const weekNum = item.chapter;
		const startMs = baseDate.getTime() + (weekNum - 1) * 7 * 24 * 60 * 60 * 1000;
		const endMs = startMs + 6 * 24 * 60 * 60 * 1000;

		const startDt = new Date(startMs);
		const endDt = new Date(endMs);

		const weekStart = formatDate(startDt);
		const weekEnd = formatDate(endDt);
		const weekLabel = formatLabel(startDt, endDt);
		const cleanTitle = `Week ${weekNum}: ${item.title}`;

		const contentLines = [
			`### Chapter ${item.chapter}. ${item.title}`,
			'',
		];

		if (item.coverage) {
			contentLines.push(`**Course Coverage:** ${item.coverage}`, '');
		}

		contentLines.push('#### Topics to be covered:');
		for (const t of item.topics) {
			contentLines.push(`- ${t}`);
		}

		if (item.problems.length > 0) {
			contentLines.push(
				'',
				`**Suggested problems:** ${item.chapter}: ${item.problems.join(', ')}`,
			);
		}

		const sectionContent = contentLines.join('\n').trim();
		const contentHash = createHash('sha256').update(sectionContent, 'utf8').digest('hex');

		const suggestedProblems = [];
		if (item.problems.length > 0) {
			suggestedProblems.push({
				section: String(item.chapter),
				title: item.title,
				raw: item.problems.join(', '),
				problems: item.problems,
			});
		}

		sections.push({
			id: `section:${courseId}:${weekNum}`,
			type: 'section',
			courseId,
			courseName,
			sectionId: weekNum,
			sectionNumber: weekNum,
			title: cleanTitle,
			name: weekLabel,
			url: metadata.fileurl || '',
			content: sectionContent,
			contentHash,
			weekStart,
			weekEnd,
			suggestedProblems,
			event: 'created',
		});
	}

	return sections;
}

export function parseSingleHomeworkPdf(pdfText, metadata = {}) {
	const courseId = metadata.courseId || extractCourseIdFromText(pdfText) || '0';
	const courseName = metadata.courseName || extractCourseNameFromText(pdfText) || 'Course';
	const title = metadata.name || metadata.filename || 'Homework Assignment';

	let dueAt = null;
	const dueMatch = pdfText.match(/(?:due\s+date|deadline|due\s+by|son\s+teslim)\s*:\s*([^\n\r]+)/i);
	if (dueMatch) {
		const parsedTimestamp = Date.parse(dueMatch[1].trim());
		if (!Number.isNaN(parsedTimestamp)) {
			dueAt = new Date(parsedTimestamp).toISOString();
		}
	}

	// Clean content
	const lines = pdfText.split('\n').map((l) => l.trim()).filter(Boolean);
	const content = lines.slice(0, 50).join('\n');
	const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');

	const homeworkId = `assignment:${courseId}:pdf-${createHash('md5').update(title).digest('hex').slice(0, 8)}`;

	return {
		id: homeworkId,
		type: 'assignment',
		courseId,
		courseName,
		moduleId: `pdf-${createHash('md5').update(title).digest('hex').slice(0, 8)}`,
		moduleType: 'pdf_assignment',
		title,
		url: metadata.fileurl || '',
		openAt: null,
		dueAt,
		closeAt: null,
		content,
		contentHash,
		event: 'created',
	};
}

export function parseCoursePdf(pdfText, metadata = {}, options = {}) {
	const hasChapterProblems = /Chapter\s+\d+\.[\s\S]*?(?:selected|suggested|recommended)\s+problems/i.test(pdfText);

	if (hasChapterProblems) {
		return {
			type: 'sections',
			items: parseChapterProblemsPdf(pdfText, metadata, options.semesterStart),
		};
	}

	return {
		type: 'assignment',
		items: [parseSingleHomeworkPdf(pdfText, metadata)],
	};
}

function extractCourseIdFromText(text) {
	const match = text.match(/(?:course\s+code|code)\s*:\s*(\d{7})/i);
	return match ? match[1] : null;
}

function extractCourseNameFromText(text) {
	const match = text.match(/\[([A-Z]{3,4}\s*\d{3}[^\]]*)\]/i);
	return match ? match[1] : null;
}
