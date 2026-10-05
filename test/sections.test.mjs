import assert from 'node:assert/strict';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	normalizeSectionHtml,
	computeContentHash,
	parseWeekDates,
	extractSectionId,
	getCourseSections,
} from '../src/odtuclass/sections.js';
import {
	createEmptyState,
	loadState,
	saveState,
	findNewAssignments,
	recordAssignments,
	findNewOrUpdatedSections,
	recordSections,
} from '../src/state.js';
import {
	getPendingFileName,
	writePendingSection,
} from '../src/pending.js';
import { syncAssignments, syncSections } from '../src/sync.js';

console.log('========================================');
console.log('   ODTUClass Section Tracking Tests     ');
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
// 1. Normalization & Content Hashing
// ----------------------------------------------------
test('normalizeSectionHtml: basic formatting and structure', () => {
	const html = `
		<p>Topics to be covered:</p>
		<p>1.3. Limits<br>1.4. Continuity</p>
		<p>Suggested problems from the textbook:&nbsp;</p>
		<ul>
			<li>1.3 : 3, 6, 9</li>
			<li>1.4: 1, 2, 3</li>
		</ul>
	`;
	const normalized = normalizeSectionHtml(html);
	assert.ok(normalized.includes('Topics to be covered:'));
	assert.ok(normalized.includes('1.3. Limits\n1.4. Continuity'));
	assert.ok(normalized.includes('Suggested problems from the textbook:'));
	assert.ok(normalized.includes('- 1.3 : 3, 6, 9'));
	assert.ok(normalized.includes('- 1.4: 1, 2, 3'));
});

test('normalizeSectionHtml: deterministic across HTML formatting differences', () => {
	const html1 = '<p>1.3 Limits&nbsp;at Infinity</p><br><p>Problems:</p><ul><li>1, 2</li></ul>';
	const html2 = '<div><p>1.3 Limits at Infinity</p></div>\n\n<p>Problems:</p>\n<ul>\n<li>1, 2</li>\n</ul>';

	const norm1 = normalizeSectionHtml(html1);
	const norm2 = normalizeSectionHtml(html2);

	assert.equal(norm1, norm2);
	assert.equal(computeContentHash(norm1), computeContentHash(norm2));
});

test('computeContentHash: empty / whitespace-only returns null', () => {
	assert.equal(computeContentHash(''), null);
	assert.equal(computeContentHash('   \n  \t '), null);
	assert.equal(computeContentHash(null), null);
	assert.equal(typeof computeContentHash('Sample Content'), 'string');
	assert.equal(computeContentHash('Sample Content').length, 64);
});

// ----------------------------------------------------
// 2. Week Date Parsing
// ----------------------------------------------------
test('parseWeekDates: valid week ranges', () => {
	const r1 = parseWeekDates('September 28 - October 4', 2026);
	assert.deepEqual(r1, { weekStart: '2026-09-28', weekEnd: '2026-10-04' });

	const r2 = parseWeekDates('October 5 - October 11', 2026);
	assert.deepEqual(r2, { weekStart: '2026-10-05', weekEnd: '2026-10-11' });

	const r3 = parseWeekDates('October 5 - 11', 2026);
	assert.deepEqual(r3, { weekStart: '2026-10-05', weekEnd: '2026-10-11' });

	const r4 = parseWeekDates('December 28 - January 3', 2026);
	assert.deepEqual(r4, { weekStart: '2026-12-28', weekEnd: '2027-01-03' });
});

test('parseWeekDates: non-date section titles return nulls', () => {
	const r1 = parseWeekDates('General');
	assert.deepEqual(r1, { weekStart: null, weekEnd: null });

	const r2 = parseWeekDates('');
	assert.deepEqual(r2, { weekStart: null, weekEnd: null });

	const r3 = parseWeekDates(null);
	assert.deepEqual(r3, { weekStart: null, weekEnd: null });
});

// ----------------------------------------------------
// 3. Section ID Extraction
// ----------------------------------------------------
test('extractSectionId: parses query parameter id', () => {
	assert.equal(
		extractSectionId('https://odtuclass2026f.metu.edu.tr/course/section.php?id=91678'),
		91678,
	);
	assert.equal(extractSectionId('invalid-url'), null);
	assert.equal(extractSectionId(''), null);
});

// ----------------------------------------------------
// 4. Extraction with Real ODTUClass HTML Fixture
// ----------------------------------------------------
await asyncTest('getCourseSections: extracts only non-empty sections from HTML', async () => {
	const fixturePath = join(tmpdir(), 'odtuclass-section-audit', 'course-page.html');
	const htmlData = await readFile(fixturePath, 'utf8');

	const mockClient = {
		baseUrl: 'https://odtuclass2026f.metu.edu.tr',
		year: 2026,
		async request() {
			return { data: htmlData };
		},
	};

	const mockCourse = {
		id: 5083,
		fullname: '[MATH 119 All Sections] Calculus with Analytic Geometry',
	};

	const sections = await getCourseSections(mockClient, mockCourse);

	// Section 0 is "General" (empty summary -> ignored)
	// Section 1 is 91678 (September 28 - October 4 -> has content)
	// Section 2 is 91679 (October 5 - October 11 -> has content)
	// Sections 3-17 are empty -> ignored
	assert.equal(sections.length, 2, 'Should only return non-empty sections');

	const s1 = sections.find((s) => s.sectionId === 91678);
	assert.ok(s1, 'Section 91678 must be present');
	assert.equal(s1.id, 'section:5083:91678');
	assert.equal(s1.name, 'September 28 - October 4');
	assert.equal(s1.weekStart, '2026-09-28');
	assert.equal(s1.weekEnd, '2026-10-04');
	assert.ok(s1.content.includes('Limits of Functions'));
	assert.ok(s1.content.includes('Suggested problems from textbook:'));
	assert.ok(!('dueAt' in s1), 'dueAt must NOT be generated for sections');

	const s2 = sections.find((s) => s.sectionId === 91679);
	assert.ok(s2, 'Section 91679 must be present');
	assert.equal(s2.id, 'section:5083:91679');
	assert.equal(s2.name, 'October 5 - October 11');
	assert.equal(s2.weekStart, '2026-10-05');
	assert.equal(s2.weekEnd, '2026-10-11');
	assert.ok(s2.content.includes('Topics to be covered:'));
	assert.ok(s2.content.includes('Suggested problems from the textbook:'));
});

// ----------------------------------------------------
// 5. Detection Logic: New, Updated, Unchanged
// ----------------------------------------------------
test('findNewOrUpdatedSections: handles new, updated, and unchanged sections', () => {
	const secA = {
		id: 'section:5083:91678',
		type: 'section',
		contentHash: 'hash-aaa',
		name: 'Week 1',
	};
	const secB = {
		id: 'section:5083:91679',
		type: 'section',
		contentHash: 'hash-bbb',
		name: 'Week 2',
	};

	// 1. Empty state -> both are created
	const state1 = { sections: {} };
	const events1 = findNewOrUpdatedSections([secA, secB], state1);
	assert.equal(events1.length, 2);
	assert.equal(events1[0].event, 'created');
	assert.equal(events1[1].event, 'created');

	// 2. Same state -> unchanged (empty result)
	const state2 = {
		sections: {
			'section:5083:91678': { contentHash: 'hash-aaa' },
			'section:5083:91679': { contentHash: 'hash-bbb' },
		},
	};
	const events2 = findNewOrUpdatedSections([secA, secB], state2);
	assert.equal(events2.length, 0);

	// 3. Section B updated with new content hash
	const secBUpdated = { ...secB, contentHash: 'hash-bbb-new' };
	const events3 = findNewOrUpdatedSections([secA, secBUpdated], state2);
	assert.equal(events3.length, 1);
	assert.equal(events3[0].id, 'section:5083:91679');
	assert.equal(events3[0].event, 'updated');
	assert.equal(events3[0].contentHash, 'hash-bbb-new');
});

// ----------------------------------------------------
// 6. State Persistence & Backward Compatibility
// ----------------------------------------------------
await asyncTest('state: backward compatibility with legacy state without sections', async () => {
	const testDir = join(tmpdir(), `odtuclass-test-state-${Date.now()}`);
	await mkdir(testDir, { recursive: true });
	const stateFile = join(testDir, 'state.json');

	// Create legacy state without sections field
	const legacyState = {
		version: 1,
		initialized: true,
		assignments: {
			'assignment:123:456': {
				id: 'assignment:123:456',
				type: 'assignment',
				title: 'Old Assignment',
			},
		},
	};
	await writeFile(stateFile, JSON.stringify(legacyState), 'utf8');

	// Load legacy state
	const loaded = await loadState(stateFile);
	assert.equal(loaded.initialized, true);
	assert.ok(loaded.assignments['assignment:123:456'], 'Assignments preserved');
	assert.deepEqual(loaded.sections, {}, 'sections defaults to empty object');

	// Record a section and save
	const mockSection = {
		id: 'section:5083:91678',
		type: 'section',
		courseId: 5083,
		courseName: 'Math',
		sectionId: 91678,
		name: 'Week 1',
		url: 'http://test',
		contentHash: 'hash-111',
		weekStart: '2026-09-28',
		weekEnd: '2026-10-04',
	};

	recordSections(loaded, [mockSection]);
	assert.ok(loaded.sections['section:5083:91678']);
	const seenAt1 = loaded.sections['section:5083:91678'].seenAt;
	assert.ok(seenAt1, 'seenAt should be populated');

	await saveState(loaded, stateFile);

	// Reload state and verify persistence
	const reloaded = await loadState(stateFile);
	assert.ok(reloaded.assignments['assignment:123:456'], 'Assignments still preserved');
	assert.ok(reloaded.sections['section:5083:91678'], 'Section preserved');
	assert.equal(reloaded.sections['section:5083:91678'].seenAt, seenAt1);

	// Updating section preserves original seenAt
	const updatedSection = { ...mockSection, contentHash: 'hash-222' };
	recordSections(reloaded, [updatedSection]);
	assert.equal(
		reloaded.sections['section:5083:91678'].seenAt,
		seenAt1,
		'Original seenAt must be preserved on update',
	);

	await rm(testDir, { recursive: true, force: true });
});

// ----------------------------------------------------
// 7. Pending File Generation (Create & Update Overwrite)
// ----------------------------------------------------
await asyncTest('pending: writes and overwrites section pending file with correct filename', async () => {
	const testDir = join(tmpdir(), `odtuclass-test-pending-${Date.now()}`);
	await mkdir(testDir, { recursive: true });

	const sectionEvent = {
		id: 'section:5083:91679',
		type: 'section',
		event: 'created',
		courseId: 5083,
		courseName: '[MATH 119 All Sections] Calculus with Analytic Geometry',
		sectionId: 91679,
		title: 'October 5 - October 11',
		name: 'October 5 - October 11',
		url: 'https://odtuclass2026f.metu.edu.tr/course/section.php?id=91679',
		contentHash: 'hash-v1',
		weekStart: '2026-10-05',
		weekEnd: '2026-10-11',
		content: 'Topics: 1.3, 1.4',
	};

	assert.equal(getPendingFileName(sectionEvent), 'section-5083-91679');

	const filePath = await writePendingSection(sectionEvent, testDir);
	assert.ok(filePath.endsWith('section-5083-91679.json'));

	const read1 = JSON.parse(await readFile(filePath, 'utf8'));
	assert.equal(read1.event, 'created');
	assert.equal(read1.contentHash, 'hash-v1');

	// Simulate updated event overwriting the same pending file
	const sectionEventUpdated = {
		...sectionEvent,
		event: 'updated',
		contentHash: 'hash-v2',
		content: 'Topics: 1.3, 1.4, 1.5',
	};

	const filePath2 = await writePendingSection(sectionEventUpdated, testDir);
	assert.equal(filePath, filePath2, 'Should overwrite same filename');

	const read2 = JSON.parse(await readFile(filePath2, 'utf8'));
	assert.equal(read2.event, 'updated');
	assert.equal(read2.contentHash, 'hash-v2');
	assert.equal(read2.content, 'Topics: 1.3, 1.4, 1.5');

	await rm(testDir, { recursive: true, force: true });
});

// ----------------------------------------------------
// 8. Existing Assignment Functions Unchanged
// ----------------------------------------------------
test('assignments: existing findNewAssignments and recordAssignments work unmodified', () => {
	const state = {
		version: 1,
		initialized: true,
		assignments: {
			'assignment:100:200': {
				id: 'assignment:100:200',
				title: 'Existing',
				seenAt: '2026-10-01T00:00:00.000Z',
			},
		},
		sections: {},
	};

	const incoming = [
		{ id: 'assignment:100:200', title: 'Existing' },
		{ id: 'assignment:100:201', title: 'New' },
	];

	const newOnes = findNewAssignments(incoming, state);
	assert.equal(newOnes.length, 1);
	assert.equal(newOnes[0].id, 'assignment:100:201');

	recordAssignments(state, incoming);
	assert.equal(state.assignments['assignment:100:200'].seenAt, '2026-10-01T00:00:00.000Z');
	assert.ok(state.assignments['assignment:100:201'].seenAt);
});

// ----------------------------------------------------
// 9. Real Production State Invariant Check
// ----------------------------------------------------
await asyncTest('production state check: loads .odtuclass/state.json without error and preserves 14 assignments', async () => {
	const prodState = await loadState('.odtuclass/state.json');
	const assignmentKeys = Object.keys(prodState.assignments);
	assert.equal(assignmentKeys.length, 14, 'Must preserve exactly 14 assignments');
	assert.ok(prodState.assignments['assignment:4701:4862'], 'Final Quiz must be present');
});

console.log(`\n========================================`);
console.log(`  ALL ${passedTests} TESTS PASSED SUCCESSFULLY!  `);
console.log(`========================================`);
