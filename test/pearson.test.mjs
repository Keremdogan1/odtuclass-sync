import assert from 'node:assert/strict';
import {
	parsePearsonDate,
	parseMyLabAssignments,
	parseMasteringAssignments,
	parsePearsonAssignments,
} from '../src/pearson/parser.js';

console.log('========================================');
console.log('      Pearson Integration Unit Tests    ');
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

// ----------------------------------------------------
// 1. Date Parsing
// ----------------------------------------------------
test('parsePearsonDate: parses MyLab US short date format', () => {
	const iso = parsePearsonDate('11/10/26 11:59pm');
	assert.ok(iso);
	// 2026-11-10 23:59 Turkish time (UTC+3) -> 2026-11-10 20:59 UTC
	assert.match(iso, /^2026-11-10T20:59:00\.000Z$/);

	const isoOct = parsePearsonDate('09/10/26 11:59pm');
	assert.ok(isoOct);
	assert.match(isoOct, /^2026-09-10T20:59:00\.000Z$/);
});

test('parsePearsonDate: parses Mastering full year date format', () => {
	const iso = parsePearsonDate('12/31/2026 11:59 PM');
	assert.ok(iso);
	assert.match(iso, /^2026-12-31T20:59:00\.000Z$/);
});

// ----------------------------------------------------
// 2. MyLab Math Parser (MATH 119)
// ----------------------------------------------------
test('parseMyLabAssignments: parses realistic MyLab Math table HTML', () => {
	const html = `
		<table class="assignment-table">
			<thead>
				<tr><th>Assignment</th><th>Due Date</th><th>Score</th></tr>
			</thead>
			<tbody>
				<tr>
					<td><a href="/Student/PlayerHomework.aspx?homeworkId=737880631&cId=9018595">Homework CH. 0: Preliminaries</a></td>
					<td>11/10/26 11:59pm</td>
					<td>Not Started</td>
				</tr>
				<tr>
					<td><a href="/Student/PlayerHomework.aspx?homeworkId=737880632&cId=9018595">Homework Limit and continuity - basics</a></td>
					<td>09/10/26 11:59pm</td>
					<td>100%</td>
				</tr>
			</tbody>
		</table>
	`;

	const items = parseMyLabAssignments(html, {
		courseId: 5083,
		courseName: '[MATH 119 All Sections] Calculus with Analytic Geometry',
	});

	assert.equal(items.length, 2);

	const hw1 = items.find((i) => i.title.includes('CH. 0'));
	assert.ok(hw1);
	assert.equal(hw1.id, 'assignment:5083:pearson-737880631');
	assert.equal(hw1.status, 'todo');
	assert.match(hw1.dueAt, /2026-11-10/);

	const hw2 = items.find((i) => i.title.includes('Limit and continuity'));
	assert.ok(hw2);
	assert.equal(hw2.id, 'assignment:5083:pearson-737880632');
	assert.equal(hw2.status, 'done');
	assert.match(hw2.dueAt, /2026-09-10/);
});

test('parseMyLabAssignments: parses raw text copy-paste fallback', () => {
	const text = `
		11/10/26 11:59pm Homework CH. 0: Preliminaries, 09/10/26 11:59pm Homework Limit and continuity - basics
	`;

	const items = parseMyLabAssignments(text, { courseId: 5083 });
	assert.equal(items.length, 2);
	assert.ok(items[0].title.includes('CH. 0: Preliminaries'));
	assert.ok(items[1].title.includes('Limit and continuity - basics'));
});

// ----------------------------------------------------
// 3. MasteringPhysics Parser (PHYS 105)
// ----------------------------------------------------
test('parseMasteringAssignments: parses Course Home assignments block', () => {
	const html = `
		<div class="myct-assignment-card">
			<a href="/myct/mastering#/assignment/1">Introduction to MasteringPhysics</a>
			<span class="due-date">12/31/2026 11:59 PM</span>
			<span class="status">6 of 6 complete</span>
		</div>
		<div class="myct-assignment-card">
			<a href="/myct/mastering#/assignment/2">Physics Primer</a>
			<span class="due-date">12/31/2026 11:59 PM</span>
			<span class="status">10 of 10 complete</span>
		</div>
		<div class="myct-assignment-card">
			<a href="/myct/mastering#/assignment/3">Mathematics Review</a>
			<span class="due-date">12/31/2026 11:59 PM</span>
			<span class="status">14 items, about 2+ hours</span>
		</div>
	`;

	const items = parseMasteringAssignments(html, {
		courseId: 4849,
		courseName: '[PHYS 105 ALL SECTIONS] General Physics I',
	});

	assert.equal(items.length, 3);

	const intro = items.find((i) => i.title === 'Introduction to MasteringPhysics');
	assert.ok(intro);
	assert.equal(intro.status, 'done');
	assert.match(intro.dueAt, /2026-12-31/);

	const primer = items.find((i) => i.title === 'Physics Primer');
	assert.ok(primer);
	assert.equal(primer.status, 'done');

	const review = items.find((i) => i.title === 'Mathematics Review');
	assert.ok(review);
	assert.equal(review.status, 'todo');
});

// ----------------------------------------------------
// 4. Universal Dispatcher
// ----------------------------------------------------
test('parsePearsonAssignments: dispatches correctly by course and content', () => {
	const mathHtml = `<table><tr><td><a href="?homeworkId=101">Homework CH. 0</a></td><td>11/10/26 11:59pm</td></tr></table>`;
	const mathRes = parsePearsonAssignments(mathHtml, {
		courseId: 5083,
		courseName: '[MATH 119 All Sections] Calculus with Analytic Geometry',
	});
	assert.equal(mathRes.length, 1);
	assert.ok(mathRes[0].title.includes('CH. 0'));

	const physHtml = `<div class="assignment-item"><a>Physics Primer</a> 12/31/2026 11:59 PM 10 of 10 complete</div>`;
	const physRes = parsePearsonAssignments(physHtml, {
		courseId: 4849,
		courseName: '[PHYS 105 ALL SECTIONS] General Physics I',
	});
	assert.equal(physRes.length, 1);
	assert.ok(physRes[0].title.includes('Physics Primer'));
});

console.log(`\n========================================`);
console.log(`  ALL ${passedTests} PEARSON TESTS PASSED! `);
console.log(`========================================\n`);
