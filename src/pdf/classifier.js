/**
 * Rule-based and Gemini AI-powered PDF Classifier
 * Determines if a course PDF document is:
 * 1) An assignment, homework, recommended problem set, or practice exercise sheet (isAssignment = true)
 * 2) Lecture slides, presentation slides, pre-lecture notes, or topic lecture notes (isSlide = true)
 * 3) Administrative / syllabus / rubric / tutorial / reference material
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
	'recitation',
	'recitations',
];

const SLIDE_KEYWORDS = [
	'slide',
	'slides',
	'slayt',
	'prelecture',
	'pre-lecture',
	'lecture note',
	'lecture notes',
	'lecture_note',
	'lecture_notes',
	'ders notu',
	'ders_notu',
	'presentation',
];

const ADMIN_OR_OTHER_NEGATIVE_KEYWORDS = [
	'formula sheet',
	'formula_sheet',
	'formül',
	'cheat sheet',
	'table of integrals',
	'periodic table',
	'exam solution',
	'quiz solution',
	'midterm solution',
	'syllabus',
	'course outline',
	'policy',
	'rubric',
	'criteria',
	'guideline',
	'guidelines',
	'tutorial',
	'how to',
	'academic integrity',
	'scheduler',
	'teams account',
	'career planning course weekly program',
	'announcement',
	'pearson help',
];

const NEGATIVE_KEYWORDS = [
	...SLIDE_KEYWORDS,
	...ADMIN_OR_OTHER_NEGATIVE_KEYWORDS,
	'handout',
];

export function ruleBasedClassify(metadata = {}, pdfText = '') {
	const name = (metadata.name || '').toLowerCase();
	const filename = (metadata.filename || '').toLowerCase();
	const folderName = (metadata.folderName || '').toLowerCase();
	const combinedMeta = `${name} ${filename} ${folderName}`;

	let score = 0;
	let slideScore = 0;
	const matchedPositives = [];
	const matchedNegatives = [];

	// Check metadata against negative keywords
	for (const neg of NEGATIVE_KEYWORDS) {
		if (combinedMeta.includes(neg)) {
			matchedNegatives.push(neg);
			score -= 8;
		}
	}

	for (const slideKw of SLIDE_KEYWORDS) {
		if (combinedMeta.includes(slideKw)) {
			slideScore += 6;
		}
	}

	for (const adminKw of ADMIN_OR_OTHER_NEGATIVE_KEYWORDS) {
		if (combinedMeta.includes(adminKw)) {
			slideScore -= 10;
		}
	}

	// Check metadata against positive keywords
	for (const pos of POSITIVE_KEYWORDS) {
		if (combinedMeta.includes(pos)) {
			matchedPositives.push(pos);
			score += 5;
			slideScore -= 6;
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

	// Content-level slide indicators
	const isLectureSlide =
		/lecture\s+\d+|slide\s+\d+|chapter\s+\d+\s+outline|agenda|learning objectives|outline\s+of\s+topics/i.test(
			pdfText,
		);
	if (isLectureSlide && !hasSelectedProblems && !hasHomeworkHeader && !hasProblemColonNumber) {
		score -= 4;
		slideScore += 5;
		matchedNegatives.push('pattern:lecture_slides');
	}

	const hasWeekSlidePattern = /\bweek\s*[-_]*0*\d{1,2}[a-d]?\b/i.test(combinedMeta);
	if (hasWeekSlidePattern && score < 3) {
		slideScore += 5;
	}

	const isAssignment = score >= 3;
	const isSlide = !isAssignment && slideScore >= 4;

	let format = 'unknown';
	if (hasChapterProblems || hasSelectedProblems) {
		format = 'weekly_problems';
	} else if (hasHomeworkHeader) {
		format = 'single_assignment';
	} else if (isAssignment) {
		format = 'problem_sheet';
	} else if (isSlide) {
		format = 'lecture_slides';
	}

	return {
		isAssignment,
		isSlide,
		confidence: Math.min(Math.max((score + 5) / 15, 0), 1),
		format,
		reason: `Rule-based evaluation: score=${score}, slideScore=${slideScore}, matchedPositives=[${matchedPositives.join(', ')}], matchedNegatives=[${matchedNegatives.join(', ')}]`,
		score,
		slideScore,
	};
}

export async function classifyWithGemini(metadata = {}, pdfText = '', apiKey = process.env.GEMINI_API_KEY) {
	if (!apiKey) {
		throw new Error('GEMINI_API_KEY is not set.');
	}

	const textExcerpt = (pdfText || '').slice(0, 4000);
	const prompt = `You are an academic document classification assistant for a university student.
Analyze the following course document metadata and text excerpt.
Classify the document into two booleans (isAssignment, isSlide) and a format string:

1. isAssignment = true when the document contains student-assigned problems, exercises, homework, recitation questions, or recommended textbook problem lists that a student should solve.
2. isSlide = true when the document is a lecture slide deck, presentation slides, pre-lecture slides, or topic lecture notes meant for teaching/studying a course topic or week (and NOT an administrative document like syllabus, grading rubric, NA criteria, schedule, software tutorial, or full 500-page textbook).
3. Both isAssignment = false and isSlide = false for administrative documents (syllabus without problem sets, grading rubrics, attendance/NA criteria, Microsoft Teams / Scheduler guides, announcements, exam solutions).

Metadata:
- Course: ${metadata.courseName || 'Unknown'}
- Folder/Section: ${metadata.folderName || metadata.sectionName || 'Unknown'}
- Resource Name: ${metadata.name || 'Unknown'}
- Filename: ${metadata.filename || 'Unknown'}

Text Excerpt:
${textExcerpt}

Respond ONLY with valid JSON in this exact structure:
{
  "isAssignment": false,
  "isSlide": true,
  "confidence": 0.95,
  "format": "weekly_problems" | "single_assignment" | "problem_sheet" | "lecture_slides" | "none",
  "reason": "short explanation"
}`;

	const candidateModels = [
		process.env.GEMINI_MODEL,
		'gemini-2.5-flash',
		'gemini-2.0-flash',
		'gemini-1.5-flash',
	].filter(Boolean);

	let lastError = null;
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
				lastError = new Error(`Gemini API (${model}) HTTP ${response.status}: ${response.statusText}`);
				continue;
			}

			const data = await response.json();
			const contentText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
			if (!contentText) {
				lastError = new Error(`Empty response from Gemini API (${model}).`);
				continue;
			}

			const parsed = JSON.parse(contentText);
			const isAssignment = Boolean(parsed.isAssignment);
			const isSlide = !isAssignment && (Boolean(parsed.isSlide) || parsed.format === 'lecture_slides');
			return {
				isAssignment,
				isSlide,
				confidence: Number(parsed.confidence) || 0.8,
				format: parsed.format || (isSlide ? 'lecture_slides' : 'unknown'),
				reason: `Gemini (${model}): ${parsed.reason || 'AI evaluated'}`,
			};
		} catch (err) {
			lastError = err;
		}
	}

	throw lastError || new Error('All Gemini candidate models failed.');
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
