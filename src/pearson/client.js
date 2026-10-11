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

		// Fallback for known courses if not found in HTML
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

	console.log(`[Pearson Playwright] Launching headless browser for ${courseName} (${launchUrl})...`);

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
					const ct = (res.headers()['content-type'] || '').toLowerCase();
					if (
						/pearson|mylab|mastering|mathxl|tpi|myct/i.test(u) &&
						(ct.includes('json') || /assignment|homework|coursehome|student|grade|item/i.test(u))
					) {
						const text = await res.text();
						if (text && text.length > 2 && text.length < 2000000) {
							console.log(
								`[Pearson API Response] status=${res.status()} url=${u.slice(0, 140)} len=${text.length}`,
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
					// ignore response read errors
				}
			});
		};

		const page = await context.newPage();
		attachResponseListener(page);
		context.on('page', (newPage) => {
			attachResponseListener(newPage);
		});

		await page.goto(launchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
		await page.waitForTimeout(5000);

		console.log(`[Pearson Playwright] Landed on URL: ${page.url()} | Title: "${await page.title()}"`);

		// Check all frames for buttons/links that launch MyLab / Mastering or Assignments
		let activePage = page;
		for (let step = 0; step < 3; step++) {
			const frames = activePage.frames();
			for (const frame of frames) {
				try {
					const fUrl = frame.url();
					if (!fUrl || fUrl === 'about:blank') continue;
					const bodyText = (await frame.locator('body').innerText({ timeout: 2000 })).trim();
					console.log(
						`[Pearson Frame step=${step}] url=${fUrl.slice(0, 120)} textSnippet="${bodyText.replace(/\s+/g, ' ').slice(0, 200)}"`,
					);

					// Look for launch button or Assignments link
					const launchLink = frame.locator(
						'a:has-text("Open MyLab"), button:has-text("Open MyLab"), a:has-text("Launch"), button:has-text("Launch"), a:has-text("Assignments"), a:has-text("All Assignments"), a:has-text("Course Home"), a[href*="PlayerHomework"], a[href*="assignments"]',
					).first();

					if ((await launchLink.count()) > 0) {
						const href = await launchLink.getAttribute('href');
						const linkText = (await launchLink.innerText()).trim();
						console.log(`[Pearson Playwright] Found interactive link/button: "${linkText}" (href=${href || 'none'})`);

						if (href && href.startsWith('http')) {
							await activePage.goto(href, { waitUntil: 'domcontentloaded', timeout: 25000 });
							await activePage.waitForTimeout(5000);
							break;
						} else {
							const popupPromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
							await launchLink.click({ timeout: 5000 }).catch(() => {});
							const popup = await popupPromise;
							if (popup) {
								activePage = popup;
								await activePage.waitForLoadState('domcontentloaded').catch(() => {});
								await activePage.waitForTimeout(5000);
							} else {
								await activePage.waitForTimeout(5000);
							}
							break;
						}
					}
				} catch {
					// ignore frame errors
				}
			}
		}

		// Collect HTML from all frames on activePage and original page
		const allHtmlBlocks = [];
		const pagesToInspect = activePage === page ? [page] : [page, activePage];
		for (const p of pagesToInspect) {
			for (const f of p.frames()) {
				try {
					const html = await f.content();
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
			console.log(`[Pearson Playwright] Extracted ${apiAssignments.length} assignments from JSON API!`);
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
				console.log(`[Pearson Playwright] Extracted ${domAssignments.length} assignments from rendered DOM!`);
				return domAssignments;
			}
		}

		return [];
	} finally {
		await browser.close();
	}
}

/**
 * Performs LTI Launch from ODTUClass into Pearson platform,
 * maintains session cookies, and fetches assignment payload.
 */
export async function fetchPearsonAssignments(client, ltiActivity) {
	const courseId = ltiActivity.courseId;
	const courseName = ltiActivity.courseName;
	const ltiId = ltiActivity.ltiId;
	const ltiUrl = ltiActivity.url;
	const launchUrl = ltiId
		? `${client.baseUrl}/mod/lti/launch.php?id=${ltiId}&triggerview=0`
		: ltiUrl;

	console.log(`[Pearson] Initiating LTI launch for ${courseName} (${launchUrl})...`);

	try {
		// Try Playwright headless browser first for full JS SPA & API support
		const pwResults = await fetchPearsonViaPlaywright(client, ltiActivity);
		if (pwResults && pwResults.length > 0) {
			return pwResults;
		}

		// Fallback to direct HTTP launch via launch.php
		const ltiPageRes = await client.request('GET', launchUrl);
		const $ = cheerio.load(ltiPageRes.data);

		const form = $(
			'form#ltiLaunchForm, form[name="ltiLaunchForm"], form[action*="pearson"], form[action*="lti"]',
		).first();
		const actionUrl = form.attr('action');

		if (!actionUrl || !actionUrl.startsWith('http')) {
			console.log(
				`[Pearson] No direct auto-submit form on ${launchUrl} (finalUrl=${ltiPageRes.finalUrl}).`,
			);
			return [];
		}

		console.log(`[Pearson HTTP] Submitting LTI form to: ${actionUrl}`);

		const formData = new URLSearchParams();
		form.find('input[name]').each((_, input) => {
			const name = $(input).attr('name');
			const value = $(input).attr('value') || '';
			formData.append(name, value);
		});

		const pearsonCookies = new Map();
		const trackCookies = (res) => {
			const setCookie = res.headers['set-cookie'];
			if (setCookie) {
				for (const c of setCookie) {
					const [nv] = c.split(';');
					const sep = nv.indexOf('=');
					if (sep > 0) {
						pearsonCookies.set(nv.slice(0, sep).trim(), nv.slice(sep + 1).trim());
					}
				}
			}
		};

		const getCookieHeader = () => {
			return Array.from(pearsonCookies.entries())
				.map(([k, v]) => `${k}=${v}`)
				.join('; ');
		};

		const launchRes = await axios.post(actionUrl, formData.toString(), {
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
				Referer: launchUrl,
			},
			maxRedirects: 5,
			validateStatus: () => true,
		});

		trackCookies(launchRes);

		const landingHtml = typeof launchRes.data === 'string' ? launchRes.data : '';
		console.log(
			`[Pearson HTTP] Landing status=${launchRes.status} len=${landingHtml.length} snippet="${landingHtml.replace(/\s+/g, ' ').slice(0, 200)}"`,
		);

		const assignments = parsePearsonAssignments(landingHtml, {
			courseId,
			courseName,
			url: ltiUrl,
		});

		if (assignments.length > 0) {
			console.log(`[Pearson] Found ${assignments.length} assignments on landing page.`);
			return assignments;
		}

		const landing$ = cheerio.load(landingHtml);
		const iframeSrc = landing$(
			'iframe[src*="assignments"], iframe[src*="PlayerHomework"], iframe[src*="myct"]',
		).attr('src');

		if (iframeSrc) {
			const fullIframeUrl = iframeSrc.startsWith('http')
				? iframeSrc
				: new URL(iframeSrc, launchRes.config.url || actionUrl).href;
			console.log(`[Pearson] Fetching assignments iframe: ${fullIframeUrl}...`);

			const iframeRes = await axios.get(fullIframeUrl, {
				headers: {
					'User-Agent':
						'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
					Cookie: getCookieHeader(),
					Referer: launchRes.config.url || actionUrl,
				},
				validateStatus: () => true,
			});

			trackCookies(iframeRes);
			const iframeHtml = typeof iframeRes.data === 'string' ? iframeRes.data : '';
			const iframeAssignments = parsePearsonAssignments(iframeHtml, {
				courseId,
				courseName,
				url: ltiUrl,
			});

			if (iframeAssignments.length > 0) {
				console.log(`[Pearson] Found ${iframeAssignments.length} assignments inside iframe.`);
				return iframeAssignments;
			}
		}

		return assignments;
	} catch (err) {
		console.warn(
			`[Pearson] Automated LTI launch encountered an error for ${courseName}: ${err.message}`,
		);
		return [];
	}
}
