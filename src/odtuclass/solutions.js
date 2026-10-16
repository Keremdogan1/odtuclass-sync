import { createHash } from 'node:crypto';

/**
 * Generates an English step-by-step Answer Key & Detailed Solutions block
 * for university assignments, recitations, and problem sheets using Gemini AI.
 * 
 * Note: Pearson assignments are excluded since they are solved directly on Pearson.
 */
export async function generateAssignmentSolutionKey(
	assignment,
	rawText,
	apiKey = process.env.GEMINI_API_KEY
) {
	if (!apiKey) {
		return null;
	}

	// Skip Pearson assignments and non-problem modules
	const modType = String(assignment.moduleType || '').toLowerCase();
	if (modType === 'pearson') {
		return null;
	}

	const title = String(assignment.title || '');
	const content = String(rawText || assignment.content || assignment.description || '');

	// Skip if content is too short or doesn't look like an exercise/recitation/problem set
	if (content.trim().length < 40) {
		return null;
	}

	const isProblemSet =
		/\b(?:recitation|problem|exercise|homework|hw|soru|alıştırma|question|ödev)\b/i.test(title) ||
		/\b(?:find|calculate|evaluate|show|prove|sketch|determine|lim|derivative|integral)\b/i.test(content) ||
		/Q\d+\b|\b\d+\.\s+[A-Z]/i.test(content);

	if (!isProblemSet) {
		return null;
	}

	console.log(`  [AI Solver] Generating English Answer Key for "${title}"...`);

	const prompt = `You are an expert university teaching assistant at METU (Middle East Technical University).
All course materials, recitations, and homework at METU are strictly in English.

Analyze and solve all the problems in the following university coursework document:
Course: ${assignment.courseName || 'METU Course'}
Title: ${title}

Document Content:
${content.slice(0, 14000)}

Instructions:
1. Provide a step-by-step, mathematically rigorous and complete Answer Key in English.
2. Clearly distinguish each question number/letter and highlight the final answer in bold (e.g. **Answer:** $...$).
3. Use clean LaTeX/KaTeX math notation ($...$ inline, $$...$$ display). Never put \\frac or complex formulas inside \\mathbf{...}; put standard markdown bold outside the math delimiters (e.g. **$...$**). Do not add spaces inside dollar delimiters (use $x$ not $ x $).
4. For Physics (PHYS 105), the course textbook is Giancoli 5th Edition (Global Edition). If citing the textbook in the vault, format links as: [[Physics For Scientists and Engineers.pdf#page=N|Giancoli 5th Ed. (Sayfa N)]].
5. Wrap your entire response in an Obsidian callout formatted exactly like this (open by default, do NOT use a minus sign):

> [!tip] 🔑 Answer Key & Detailed Solutions
>
> ### Q1. ...
> - **Steps:** ...
> - **Final Answer:** ...
>
> ---
>
> ### Q2. ...

Do NOT wrap the callout in markdown backtick code blocks. Start directly with "> [!tip]".`;

	const candidateModels = [
		process.env.GEMINI_MODEL,
		'gemini-flash-latest',
		'gemini-2.5-flash',
		'gemini-2.0-flash',
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
					},
				}),
			});

			if (!response.ok) {
				continue;
			}

			const data = await response.json();
			const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
			if (text && text.includes('[!tip]')) {
				console.log(`  [AI Solver] Successfully generated Answer Key using model ${model}`);
				return text.trim();
			}
		} catch (err) {
			console.warn(`  [AI Solver] Model ${model} failed: ${err.message}`);
		}
	}

	return null;
}
