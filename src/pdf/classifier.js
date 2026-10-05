/**
 * Rule-based and Gemini AI-powered PDF Classifier
 * Determines if a course PDF document is an assignment, homework,
 * recommended problem set, or practice exercise sheet vs. lecture slides/notes.
 */

const POSITIVE_KEYWORDS = [
	'problem',
	'problems',
	'homework',
	'hw',
	'assignment',
	'ödev',
	'odev',
	'soru',
	'sorular',
	'exercise',
	'exercises',
	'practice',
	'recommended',
	'selected',
	'suggested',
	'pset',
	'problem set',
];

const NEGATIVE_KEYWORDS = [
	'slide',
	'slides',
	'slayt',
	'lecture note',
	'lecture notes',
	'lecture_note',
	'lecture_notes',
	'ders notu',
	'ders_notu',
	'formula sheet',
	'formula_sheet',
	'formül',
	'cheat sheet',
	'handout',
	'table of integrals',
	'periodic table',
	'exam solution',
	'quiz solution',
	'midterm solution',
];

export function ruleBasedClassify(metadata = {}, pdfText = '') {
	const name = (metadata.name || '').toLowerCase();
	const filename = (metadata.filename || '').toLowerCase();
	const combinedMeta = `${name} ${filename}`;
	const text = (pdfText || '').toLowerCase();

	let score = 0;
	const matchedPositives = [];
	const matchedNegatives = [];

	// Check metadata against negative keywords
	for (const neg of NEGATIVE_KEYWORDS) {
		if (combinedMeta.includes(neg)) {
			matchedNegatives.push(neg);
			score -= 5;
		}
	}

	// Check metadata against positive keywords
	for (const pos of POSITIVE_KEYWORDS) {
		if (combinedMeta.includes(pos)) {
			matchedPositives.push(pos);
			score += 5;
		}
	}

	// Check text patterns for problem listings and syllabus homework sections
	const hasSelectedProblems = /(?:selected|suggested|recommended)\s+problems/i.test(pdfText);
	const hasChapterProblems = /chapter\s+\d+[\s\S]*?(?:selected|suggested|recommended|problems)/i.test(pdfText);
	const hasHomeworkHeader = /(?:homework|assignment|problem set|ödev)\s*(?:#|no\.?|number)?\s*\d+/i.test(pdfText);
	const hasProblemColonNumber = /\b\d+\.\d+\s*:\s*\d+/i.test(pdfText);
	const hasDueOrDeadline = /(?:due\s+date|deadline|submission\s+deadline|due\s+by|son\s+teslim)\s*:/i.test(pdfText);

	if (hasSelectedProblems) {
		score += 6;
		matchedPositives.push('pattern:selected_problems');
	}
	if (hasChapterProblems) {
		score += 5;
		matchedPositives.push('pattern:chapter_problems');
	}
	if (hasHomeworkHeader) {
		score += 6;
		matchedPositives.push('pattern:homework_header');
	}
	if (hasProblemColonNumber) {
		score += 4;
		matchedPositives.push('pattern:problem_colon_number');
	}
	if (hasDueOrDeadline) {
		score += 3;
		matchedPositives.push('pattern:due_date');
	}

	// Content-level negative indicators (e.g. presentation slides / lecture title pages)
	const isLectureSlide = /lecture\s+\d+|slide\s+\d+|chapter\s+\d+\s+outline|agenda|learning objectives/i.test(pdfText);
	if (isLectureSlide && !hasSelectedProblems && !hasHomeworkHeader && !hasProblemColonNumber) {
		score -= 4;
		matchedNegatives.push('pattern:lecture_slides');
	}

	const isAssignment = score >= 3;
	let format = 'unknown';
	if (hasChapterProblems || hasSelectedProblems) {
		format = 'weekly_problems';
	} else if (hasHomeworkHeader) {
		format = 'single_assignment';
	} else if (isAssignment) {
		format = 'problem_sheet';
	}

	return {
		isAssignment,
		confidence: Math.min(Math.max((score + 5) / 15, 0), 1),
		format,
		reason: `Rule-based evaluation: score=${score}, matchedPositives=[${matchedPositives.join(', ')}], matchedNegatives=[${matchedNegatives.join(', ')}]`,
		score,
	};
}

export async function classifyWithGemini(metadata = {}, pdfText = '', apiKey = process.env.GEMINI_API_KEY) {
	if (!apiKey) {
		throw new Error('GEMINI_API_KEY is not set.');
	}

	const textExcerpt = (pdfText || '').slice(0, 4000);
	const prompt = `You are an academic document classification assistant for a university student.
Analyze the following course document metadata and text excerpt.
Determine if this document contains student-assigned problems, exercises, homework, or recommended practice problems that a student should work on/solve.

IMPORTANT CRITERIA:
- RETURN isAssignment = true for:
  * Homework assignments / problem sets / psets.
  * Recommended or suggested textbook problem lists (e.g. weekly course syllabus listing assigned exercises).
  * Exercise sheets or practice problems.
- RETURN isAssignment = false for:
  * Lecture slides, slide presentations, lecture notes.
  * Formula sheets, periodic tables, integral tables.
  * General course administrative syllabus with NO exercise problem lists.
  * Exam / quiz solution sheets.

Metadata:
- Course: ${metadata.courseName || 'Unknown'}
- Resource Name: ${metadata.name || 'Unknown'}
- Filename: ${metadata.filename || 'Unknown'}

Text Excerpt:
${textExcerpt}

Respond ONLY with valid JSON in this exact structure:
{
  "isAssignment": true,
  "confidence": 0.95,
  "format": "weekly_problems" | "single_assignment" | "problem_sheet" | "none",
  "reason": "short explanation"
}`;

	const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
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
		throw new Error(`Gemini API error HTTP ${response.status}: ${response.statusText}`);
	}

	const data = await response.json();
	const contentText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
	if (!contentText) {
		throw new Error('Empty response from Gemini API.');
	}

	const parsed = JSON.parse(contentText);
	return {
		isAssignment: Boolean(parsed.isAssignment),
		confidence: Number(parsed.confidence) || 0.8,
		format: parsed.format || 'unknown',
		reason: `Gemini (${model}): ${parsed.reason || 'AI evaluated'}`,
	};
}

export async function classifyPdf(metadata = {}, pdfText = '', options = {}) {
	const apiKey = options.apiKey || process.env.GEMINI_API_KEY;

	if (apiKey) {
		try {
			return await classifyWithGemini(metadata, pdfText, apiKey);
		} catch (error) {
			console.warn(`[Classifier] Gemini AI classification failed, falling back to heuristics: ${error.message}`);
		}
	}

	return ruleBasedClassify(metadata, pdfText);
}
