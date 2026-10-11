import * as cheerio from 'cheerio';
import axios from 'axios';
import { parsePearsonAssignments, parsePearsonApiPayloads } from './parser.js';

export const KNOWN_PEARSON_LTI = {
	5083: { id: 24039, name: 'Pearson MyLab (MATH 119)' },
	4849: { id: 8699, name: 'MasteringPhysics (PHYS 105)' },
};

/**
 * Searches course page HTML for Pearson / MyLab / Mastering LTI activities
 */
export async function findPearsonLtiActivities(client, course) {
	try {
		const response = await client.request(
			'GET',
			`${client.baseUrl}/course/view.php?id=${course.id}`,
		);

		const $ = cheerio.load(response.data);
		const activities = [];
		const seenIds = new Set();

		$('a[href*="mod/lti/view.php"]').each((_, a) => {
			const href = $(a).attr('href') || '';
			const text = $(a).text().trim();
			const parentText = $(a).closest('li.activity, .activity-item').text().trim();

			const isPearson =
				/pearson|mylab|mastering/i.test(text) ||
				/pearson|mylab|mastering/i.test(parentText) ||
				/id=24039|id=8699|id=10016/.test(href);

			if (isPearson) {
				const idMatch = href.match(/id=(\d+)/);
				const ltiId = idMatch ? parseInt(idMatch[1], 10) : null;
				if (ltiId && seenIds.has(ltiId)) return;
				if (ltiId) seenIds.add(ltiId);

				activities.push({
					courseId: course.id,
					courseName: course.fullname,
					ltiId,
					title: text || 'Pearson MyLab',
					url: new URL(href, client.baseUrl).href,
				});
			}
		});

		if (activities.length === 0 && KNOWN_PEARSON_LTI[course.id]) {
			const known = KNOWN_PEARSON_LTI[course.id];
			activities.push({
				courseId: course.id,
				courseName: course.fullname,
				ltiId: known.id,
				title: known.name,
				url: `${client.baseUrl}/mod/lti/view.php?id=${known.id}`,
			});
		}

		return activities;
	} catch (err) {
		console.warn(`[Pearson] Failed to scan LTI for course ${course.id}: ${err.message}`);
		return [];
	}
}

async function fetchPearsonViaPlaywright(client, ltiActivity) {
	let chromium;
	try {
		const pw = await import('playwright');
		chromium = pw.chromium;
	} catch {
		return null;
	}

	const courseId = ltiActivity.courseId;
	const courseName = ltiActivity.courseName;
	const ltiId = ltiActivity.ltiId;
	const launchUrl = ltiId
		? `${client.baseUrl}/mod/lti/launch.php?id=${ltiId}&triggerview=0`
		: ltiActivity.url;

	console.log(
		`[Pearson Playwright] Launching headless browser for ${courseName} (${launchUrl})...`,
	);

	const browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext({
			userAgent:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
		});

		const baseHost = new URL(client.baseUrl).hostname;
		const cookieList = Object.entries(client.cookies || {}).map(([name, value]) => ({
			name,
			value: String(value),
			domain: baseHost,
			path: '/',
			secure: true,
		}));
		if (cookieList.length > 0) {
			await context.addCookies(cookieList);
		}

		const capturedApiPayloads = [];
		const attachResponseListener = (targetPage) => {
			targetPage.on('response', async (res) => {
				try {
					const u = res.url();
					if (
						/go-mpulse|nr-data|5iZsi4dvD|google-analytics|doubleclick|fonts\.|zoominsoftware|platform-terms|feature\/config|telemetry|sessioninfo|onetrust/i.test(
							u,
						)
					) {
						return;
					}
					const ct = (res.headers()['content-type'] || '').toLowerCase();
					const reqType = res.request().resourceType();
					if (ct.includes('json') || reqType === 'xhr' || reqType === 'fetch') {
						const text = await res.text();
						if (text && text.length > 2 && text.length < 2000000) {
							const maxSample = u.includes('links/search') ? 2500 : 350;
							console.log(
								`[Pearson API] status=${res.status()} url=${u.slice(0, 150)} len=${text.length} sample=${text.replace(/\s+/g, ' ').slice(0, maxSample)}`,
							);
							try {
								const json = JSON.parse(text);
								capturedApiPayloads.push({ url: u, data: json });
							} catch {
								// non-JSON text
							}
						}
					}
				} catch {
					// ignore
				}
			});
		};

		const page = await context.newPage();
		attachResponseListener(page);
		context.on('page', (newPage) => {
			console.log(`[Pearson Playwright] New tab opened: ${newPage.url()}`);
			attachResponseListener(newPage);
		});

		await page.goto(launchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

		// Wait up to 20s for Pearson Console Dashboard to render
		await page
			.waitForFunction(
				() => document.body && document.body.innerText.trim().length > 30,
				{ timeout: 20000 },
			)
			.catch(() => {});
		await page.waitForTimeout(3000);

		console.log(
			`[Pearson Playwright] Landed on URL: ${page.url()} | Title: "${await page.title()}"`,
		);

		// Extract the "Open MyLab" / "Open Mastering" href if present
		const openHref = await page
			.locator('a:has-text("Open MyLab"), a:has-text("Open Mastering")')
			.first()
			.getAttribute('href')
			.catch(() => null);

		// Also click the "Assignments" link on the dashboard via DOM click
		const assignmentsLink = page.locator('a:has-text("Assignments")').first();
		if ((await assignmentsLink.count()) > 0) {
			console.log('[Pearson Playwright] Triggering DOM click on "Assignments" link...');
			await assignmentsLink.evaluate((el) => el.click()).catch(() => {});
			await page.waitForTimeout(8000);
		}

		// Also navigate directly to openHref in a second tab to capture Course Home / MyLab / Mastering
		if (openHref && openHref.startsWith('http')) {
			console.log(`[Pearson Playwright] Navigating directly to course URL: ${openHref}`);
			const coursePage = await context.newPage();
			attachResponseListener(coursePage);
			await coursePage
				.goto(openHref, { waitUntil: 'domcontentloaded', timeout: 25000 })
				.catch((e) => console.warn(`  coursePage goto warn: ${e.message}`));
			await coursePage.waitForTimeout(10000);
		}

		// Inspect all open pages and their frames
		const allHtmlBlocks = [];
		for (const p of context.pages()) {
			console.log(`[Pearson Page Summary] url=${p.url()} title="${await p.title().catch(() => '')}"`);
			for (const f of p.frames()) {
				try {
					const fUrl = f.url();
					if (!fUrl || fUrl === 'about:blank' || fUrl.includes('checkSessionFrame')) {
						continue;
					}
					const bodyText = (
						await f.locator('body').innerText({ timeout: 2500 }).catch(() => '')
					).trim();
					if (bodyText) {
						console.log(
							`  [Frame] url=${fUrl.slice(0, 130)} text="${bodyText.replace(/\s+/g, ' ').slice(0, 500)}"`,
						);
					}
					const html = await f.content().catch(() => '');
					if (html && html.length > 50) {
						allHtmlBlocks.push(html);
					}
				} catch {
					// ignore
				}
			}
		}

		// 1. Try parsing captured JSON API payloads first
		const apiAssignments = parsePearsonApiPayloads(capturedApiPayloads, {
			courseId,
			courseName,
			url: ltiActivity.url,
		});
		if (apiAssignments.length > 0) {
			console.log(
				`[Pearson Playwright] Extracted ${apiAssignments.length} assignments from JSON API!`,
			);
			return apiAssignments;
		}

		// 2. Try parsing rendered HTML frames
		for (const html of allHtmlBlocks) {
			const domAssignments = parsePearsonAssignments(html, {
				courseId,
				courseName,
				url: ltiActivity.url,
			});
			if (domAssignments.length > 0) {
				console.log(
					`[Pearson Playwright] Extracted ${domAssignments.length} assignments from rendered DOM!`,
				);
				return domAssignments;
			}
		}

		return [];
	} finally {
		await browser.close();
	}
}

export async function fetchPearsonAssignments(client, ltiActivity) {
	const courseName = ltiActivity.courseName;
	const ltiId = ltiActivity.ltiId;
	const launchUrl = ltiId
		? `${client.baseUrl}/mod/lti/launch.php?id=${ltiId}&triggerview=0`
		: ltiActivity.url;

	console.log(`[Pearson] Initiating LTI launch for ${courseName} (${launchUrl})...`);

	try {
		const pwResults = await fetchPearsonViaPlaywright(client, ltiActivity);
		if (pwResults && pwResults.length > 0) {
			return pwResults;
		}
		return [];
	} catch (err) {
		console.warn(
			`[Pearson] Automated LTI launch encountered an error for ${courseName}: ${err.message}`,
		);
		return [];
	}
}
