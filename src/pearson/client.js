import * as cheerio from 'cheerio';
import axios from 'axios';
import { parsePearsonAssignments } from './parser.js';

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

		$('a[href*="mod/lti/view.php"]').each((_, a) => {
			const href = $(a).attr('href') || '';
			const text = $(a).text().trim();
			const parentText = $(a).closest('li.activity, .activity-item').text().trim();

			const isPearson = /pearson|mylab|mastering/i.test(text) ||
				/pearson|mylab|mastering/i.test(parentText) ||
				/id=24039|id=8699/.test(href);

			if (isPearson) {
				const idMatch = href.match(/id=(\d+)/);
				const ltiId = idMatch ? parseInt(idMatch[1], 10) : null;
				activities.push({
					courseId: course.id,
					courseName: course.fullname,
					ltiId,
					title: text || 'Pearson MyLab',
					url: href,
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

/**
 * Performs LTI Launch from ODTUClass into Pearson platform,
 * maintains session cookies, and fetches assignment payload.
 */
export async function fetchPearsonAssignments(client, ltiActivity) {
	const courseId = ltiActivity.courseId;
	const courseName = ltiActivity.courseName;
	const ltiUrl = ltiActivity.url;

	console.log(`[Pearson] Initiating LTI launch for ${courseName} (${ltiUrl})...`);

	try {
		// 1. Fetch ODTUClass LTI Launch page
		const ltiPageRes = await client.request('GET', ltiUrl);
		const $ = cheerio.load(ltiPageRes.data);

		// 2. Find LTI Launch Form
		const form = $('form[action*="pearson"], form[action*="lti"], form#ltiLaunchForm, form').first();
		const actionUrl = form.attr('action');

		if (!actionUrl || !actionUrl.startsWith('http')) {
			console.log(`[Pearson] No direct auto-submit form on ${ltiUrl}. Check if manual launch is required.`);
			return [];
		}

		// 3. Extract all form inputs (OAuth & LTI launch parameters)
		const formData = new URLSearchParams();
		form.find('input[name]').each((_, input) => {
			const name = $(input).attr('name');
			const value = $(input).attr('value') || '';
			formData.append(name, value);
		});

		// 4. Create an isolated cookie-tracking axios instance for Pearson session
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

		// 5. POST LTI Launch
		const launchRes = await axios.post(actionUrl, formData.toString(), {
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				Referer: ltiUrl,
			},
			maxRedirects: 5,
			validateStatus: () => true,
		});

		trackCookies(launchRes);

		const landingHtml = typeof launchRes.data === 'string' ? launchRes.data : '';
		const assignments = parsePearsonAssignments(landingHtml, {
			courseId,
			courseName,
			url: ltiUrl,
		});

		// If initial landing page yielded assignments
		if (assignments.length > 0) {
			console.log(`[Pearson] Found ${assignments.length} assignments on landing page.`);
			return assignments;
		}

		// Check if landing page references an iframe or assignments endpoint
		const landing$ = cheerio.load(landingHtml);
		const iframeSrc = landing$('iframe[src*="assignments"], iframe[src*="PlayerHomework"], iframe[src*="myct"]').attr('src');

		if (iframeSrc) {
			const fullIframeUrl = iframeSrc.startsWith('http') ? iframeSrc : new URL(iframeSrc, launchRes.config.url || actionUrl).href;
			console.log(`[Pearson] Fetching assignments iframe: ${fullIframeUrl}...`);

			const iframeRes = await axios.get(fullIframeUrl, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
		console.warn(`[Pearson] Automated LTI launch encountered an error for ${courseName}: ${err.message}`);
		return [];
	}
}
