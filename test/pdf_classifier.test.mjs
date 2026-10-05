import assert from 'node:assert/strict';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ruleBasedClassify } from '../src/pdf/classifier.js';
import {
	extractPdfText,
	parseChapterProblemsPdf,
	parseSingleHomeworkPdf,
	parseCoursePdf,
	parseTokensToNumbers,
} from '../src/pdf/extractor.js';
import { extractResourcesFromApi } from '../src/odtuclass/resources.js';
import {
	createEmptyState,
	loadState,
	saveState,
	findNewOrUpdatedResources,
	recordResources,
} from '../src/state.js';
import { syncResources, saveResourceState } from '../src/sync.js';

console.log('========================================');
console.log('   Course PDF Classifier & Extractor Tests  ');
console.log('========================================\n');

let passedTests = 0;
function test(name, fn) {
	try {
		fn();
		console.log(`✓ ${name}`);
		passedTests++;
	} catch (err) {
		console.error(`✗ ${name}`);
		console.error(err);
		process.exit(1);
	}
}

async function asyncTest(name, fn) {
	try {
		await fn();
		console.log(`✓ ${name}`);
		passedTests++;
	} catch (err) {
		console.error(`✗ ${name}`);
		console.error(err);
		process.exit(1);
	}
}

// ----------------------------------------------------
// 1. Rule-Based PDF Classification
// ----------------------------------------------------
test('ruleBasedClassify: identifies problem and homework PDFs as assignments', () => {
	const physMeta = {
		name: 'Recommended Problems.pdf',
		filename: 'Recommended Problems.pdf',
	};
	const physText = `
		Sayfa 1/3
		PHYS 105 — GENERAL PHYSICS I
		COURSE CONTENT AND SELECTED CHAPTER-END PROBLEMS TO BE SOLVED AS EXAMPLES
		Chapter 1. Introduction, Measurement, Estimating
		Course coverage: Self-study Selected problems: —
		Chapter 2. Describing Motion
		Selected problems: 27, 43, 47, 64, 69, 78, 93
	`;
	const resPhys = ruleBasedClassify(physMeta, physText);
	assert.equal(resPhys.isAssignment, true);
	assert.equal(resPhys.format, 'weekly_problems');
	assert.ok(resPhys.score >= 10);

	const hwMeta = {
		name: 'Homework Assignment 2',
		filename: 'hw2_instructions.pdf',
	};
	const hwText = `
		CENG 242 Programming Language Concepts
		Homework 2
		Due Date: November 20, 2026 23:59
		Problem 1: Parser in Haskell
	`;
	const resHw = ruleBasedClassify(hwMeta, hwText);
	assert.equal(resHw.isAssignment, true);
	assert.equal(resHw.format, 'single_assignment');
	assert.ok(resHw.score >= 10);
});

test('ruleBasedClassify: rejects lecture slides, notes, and formula sheets', () => {
	const slideMeta = {
		name: 'Lecture 03 - Kinematics',
		filename: 'ch03_lecture_slides.pdf',
	};
	const slideText = `
		PHYS 105 Lecture 3
		Outline & Agenda
		Learning Objectives
		Position, Velocity, Acceleration vectors
		Slide 1 of 40
	`;
	const resSlide = ruleBasedClassify(slideMeta, slideText);
	assert.equal(resSlide.isAssignment, false);
	assert.ok(resSlide.score < 0);

	const formulaMeta = {
		name: 'Formula Sheet for Midterm',
		filename: 'PHYS105_formula_sheet.pdf',
	};
	const formulaText = `
		Midterm 1 Formula Sheet
		v = v0 + at
		x = x0 + v0 t + 1/2 a t^2
		F = ma
	`;
	const resFormula = ruleBasedClassify(formulaMeta, formulaText);
	assert.equal(resFormula.isAssignment, false);
	assert.ok(resFormula.score < 0);
});

// ----------------------------------------------------
// 2. Token & Number Range Parsing
// ----------------------------------------------------
test('parseTokensToNumbers: parses lists and ranges accurately', () => {
	assert.deepEqual(parseTokensToNumbers('—'), []);
	assert.deepEqual(parseTokensToNumbers('-'), []);
	assert.deepEqual(parseTokensToNumbers(''), []);
	assert.deepEqual(parseTokensToNumbers('27, 43, 47'), ['27', '43', '47']);
	assert.deepEqual(parseTokensToNumbers('1-4, 7, 9-11'), ['1', '2', '3', '4', '7', '9', '10', '11']);
	assert.deepEqual(parseTokensToNumbers('3; 5; 8'), ['3', '5', '8']);
});

// ----------------------------------------------------
// 3. Syllabus / Chapter Problems Parsing
// ----------------------------------------------------
test('parseChapterProblemsPdf: extracts structured chapters and problems with dates', () => {
	const sampleText = `
		Course Code: 2300105
		[PHYS 105 All Sections] General Physics I
		Chapter 1. Measurement & Estimating
		• 1-1 How Science Works
		• 1-2 Units
		Course coverage: Self-study Selected problems: —
		Chapter 2. Kinematics
		• 2-1 Displacement
		• 2-2 Velocity
		Course coverage: Lectures 1-3 Selected problems: 1, 3, 5-7
	`;

	const sections = parseChapterProblemsPdf(sampleText, {
		courseId: 2300105,
		courseName: '[PHYS 105 All Sections] General Physics I',
	}, '2026-09-28');

	assert.equal(sections.length, 2);

	const s1 = sections[0];
	assert.equal(s1.sectionNumber, 1);
	assert.equal(s1.title, 'Week 1: Measurement & Estimating');
	assert.equal(s1.weekStart, '2026-09-28');
	assert.equal(s1.weekEnd, '2026-10-04');
	assert.equal(s1.suggestedProblems.length, 0);

	const s2 = sections[1];
	assert.equal(s2.sectionNumber, 2);
	assert.equal(s2.title, 'Week 2: Kinematics');
	assert.equal(s2.weekStart, '2026-10-05');
	assert.equal(s2.weekEnd, '2026-10-11');
	assert.equal(s2.suggestedProblems.length, 1);
	assert.deepEqual(s2.suggestedProblems[0].problems, ['1', '3', '5', '6', '7']);
});

// ----------------------------------------------------
// 4. Single Homework Parsing
// ----------------------------------------------------
test('parseSingleHomeworkPdf: extracts due date and content', () => {
	const sampleText = `
		CENG 242 Homework 1
		Due Date: 2026-11-15T20:59:00.000Z
		Instructions:
		Write a parser for the grammar.
	`;
	const hw = parseSingleHomeworkPdf(sampleText, {
		courseId: 5083,
		courseName: 'CENG 242',
		name: 'Homework 1',
	});

	assert.equal(hw.type, 'assignment');
	assert.equal(hw.courseId, 5083);
	assert.equal(hw.title, 'Homework 1');
	assert.equal(hw.dueAt, '2026-11-15T20:59:00.000Z');
	assert.ok(hw.content.includes('Write a parser'));
});

// ----------------------------------------------------
// 5. parseCoursePdf dispatcher
// ----------------------------------------------------
test('parseCoursePdf: dispatches between chapter syllabus and single homework', () => {
	const chapterText = `
		Chapter 1. Test
		Selected problems: 1, 2
	`;
	const resCh = parseCoursePdf(chapterText, { courseId: 101 });
	assert.equal(resCh.type, 'sections');
	assert.equal(resCh.items.length, 1);

	const hwText = `
		Homework 1
		Deadline: 2026-10-20
	`;
	const resHw = parseCoursePdf(hwText, { courseId: 101, name: 'HW 1' });
	assert.equal(resHw.type, 'assignment');
	assert.equal(resHw.items.length, 1);
});

// ----------------------------------------------------
// 6. Moodle API Resource Extraction
// ----------------------------------------------------
test('extractResourcesFromApi: filters PDF modules from course sections', () => {
	const mockCourse = { id: 2300105, fullname: 'General Physics I' };
	const mockSections = [
		{
			id: 100,
			name: 'General',
			modules: [
				{
					id: 201,
					modname: 'forum',
					name: 'Announcements',
				},
				{
					id: 202,
					modname: 'resource',
					name: 'Recommended Problems',
					contents: [
						{
							filename: 'Recommended Problems.pdf',
							fileurl: 'https://odtuclass.metu.edu.tr/pluginfile.php/202/mod_resource/content/1/Recommended%20Problems.pdf',
							mimetype: 'application/pdf',
							filesize: 123456,
							timemodified: 1727700000,
						},
					],
				},
				{
					id: 203,
					modname: 'resource',
					name: 'Lecture Video Links',
					contents: [
						{
							filename: 'links.txt',
							fileurl: 'https://odtuclass.metu.edu.tr/links.txt',
							mimetype: 'text/plain',
							filesize: 50,
							timemodified: 1727700100,
						},
					],
				},
			],
		},
	];

	const resources = extractResourcesFromApi(mockCourse, mockSections);
	assert.equal(resources.length, 1);
	assert.equal(resources[0].id, 'resource:2300105:202');
	assert.equal(resources[0].filename, 'Recommended Problems.pdf');
	assert.equal(resources[0].courseId, 2300105);
	assert.equal(resources[0].filesize, 123456);
});

// ----------------------------------------------------
// 7. Resource State Management & Persistence
// ----------------------------------------------------
await asyncTest('resources state: detection and persistence across runs', async () => {
	const testDir = join(tmpdir(), `odtuclass-test-res-state-${Date.now()}`);
	await mkdir(testDir, { recursive: true });
	const stateFile = join(testDir, 'state.json');

	const r1 = {
		id: 'resource:100:201',
		courseId: 100,
		courseName: 'Physics',
		moduleId: 201,
		name: 'Recommended Problems',
		filename: 'probs.pdf',
		fileurl: 'https://odtuclass/probs.pdf',
		timemodified: 1000,
	};

	// 1. Initial run: r1 is new
	const sync1 = await syncResources([r1], stateFile);
	assert.equal(sync1.newOrUpdated.length, 1);
	assert.equal(sync1.newOrUpdated[0].event, 'created');

	// Save state with classification
	r1.isAssignment = true;
	r1.format = 'weekly_problems';
	await saveResourceState([r1], stateFile);

	// 2. Second run with same resource: unchanged
	const sync2 = await syncResources([r1], stateFile);
	assert.equal(sync2.newOrUpdated.length, 0);

	// 3. Resource updated (timemodified changed)
	const r1Updated = { ...r1, timemodified: 2000 };
	const sync3 = await syncResources([r1Updated], stateFile);
	assert.equal(sync3.newOrUpdated.length, 1);
	assert.equal(sync3.newOrUpdated[0].event, 'updated');

	// Reload state and verify preserved fields
	const loaded = await loadState(stateFile);
	assert.ok(loaded.resources['resource:100:201']);
	assert.equal(loaded.resources['resource:100:201'].isAssignment, true);
	assert.equal(loaded.resources['resource:100:201'].format, 'weekly_problems');

	await rm(testDir, { recursive: true, force: true });
});

// ----------------------------------------------------
// 8. Real PHYS 105 PDF Parsing Parity Check
// ----------------------------------------------------
await asyncTest('real PDF test: extracts all 12 chapters from PHYS 105 Recommended Problems', async () => {
	const pdfPath = 'C:/Programming_Folder/Obsidian/Obsidian-Vault/Courses/PHYS105/Recommended Problems.pdf';
	const buf = await readFile(pdfPath);
	const text = await extractPdfText(buf);

	assert.ok(text.length > 5000);
	assert.ok(text.includes('PHYS 105'));

	const parsed = parseCoursePdf(text, {
		courseId: 2300105,
		courseName: '[PHYS 105 All Sections] General Physics I',
		fileurl: 'https://odtuclass.metu.edu.tr/phys105-problems.pdf',
	});

	assert.equal(parsed.type, 'sections');
	assert.equal(parsed.items.length, 12, 'Must extract exactly 12 weekly chapters');

	const ch2 = parsed.items[1];
	assert.equal(ch2.title, 'Week 2: Describing Motion: Kinematics in One Dimension');
	assert.equal(ch2.suggestedProblems.length, 1);
	assert.deepEqual(ch2.suggestedProblems[0].problems, ['27', '43', '47', '64', '69', '78', '93']);
	assert.equal(ch2.weekStart, '2026-10-05');
	assert.equal(ch2.weekEnd, '2026-10-11');
});

console.log(`\n========================================`);
console.log(`  ALL ${passedTests} TESTS PASSED SUCCESSFULLY!  `);
console.log(`========================================`);
