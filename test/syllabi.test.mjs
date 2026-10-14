import assert from 'node:assert/strict';
import { extractSyllabusWithGemini } from '../src/odtuclass/syllabi.js';

console.log('Testing Syllabi extraction fallback...');

const sampleSyllabusText = `
METU DEPARTMENT OF MATHEMATICS
MATH 119 CALCULUS WITH ANALYTIC GEOMETRY
2026-2027 FALL SEMESTER

Course Coordinator: Prof. Dr. Yilmaz Akyildiz
Instructors: Assoc. Prof. Dr. Ibrahim Unal (unal@metu.edu.tr), Office: M-120

EVALUATION & GRADING POLICY:
- Midterm Exam 1: 30% (November 15, 2026 at 14:00)
- Midterm Exam 2: 30% (December 20, 2026 at 14:00)
- Final Examination: 35%
- Recitation Quizzes: 5% (Best 4 out of 5)

NA Criteria: A student who fails to attend at least 70% or scores less than 20 in midterms will receive NA.

TEXTBOOK:
Calculus: A Complete Course, 9th Edition by Robert A. Adams and Christopher Essex.
`;

const res = await extractSyllabusWithGemini(sampleSyllabusText, { fullname: 'MATH 119 Calculus' }, null);

assert.ok(res.grading.length >= 2, 'Grading components extracted');
console.log('Fallback grading parsed:', res.grading);
console.log('✓ Syllabi unit test passed successfully!');
