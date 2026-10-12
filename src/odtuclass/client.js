import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';

export function resolveAcademicTerm(now = new Date(), configPath = path.resolve(process.cwd(), '.odtuclass/config.json')) {
	let cfgYear = process.env.ODTU_YEAR;
	let cfgSem = process.env.ODTU_SEMESTER;

	try {
		if (fs.existsSync(configPath)) {
			const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			if (!cfgYear && raw?.academicYear && raw.academicYear !== 'auto') {
				cfgYear = String(raw.academicYear);
			}
			if (!cfgSem && raw?.semester && raw.semester !== 'auto') {
				cfgSem = String(raw.semester);
			}
		}
	} catch {
		// ignore config read errors
	}

	const month = now.getMonth() + 1; // 1..12
	const calendarYear = now.getFullYear();

	let autoYear = calendarYear;
	let autoSem = 'f';

	if (month >= 9 && month <= 12) {
		autoYear = calendarYear;
		autoSem = 'f';
	} else if (month === 1) {
		// January belongs to the Fall semester that started in September of the previous calendar year
		autoYear = calendarYear - 1;
		autoSem = 'f';
	} else if (month >= 2 && month <= 6) {
		autoYear = calendarYear;
		autoSem = 's';
	} else {
		autoYear = calendarYear;
		autoSem = 'u';
	}

	const year = cfgYear ? Number.parseInt(cfgYear, 10) || autoYear : autoYear;
	const semester = (cfgSem ? cfgSem.trim().toLowerCase() : autoSem) || autoSem;

	return { year, semester };
}

export function makeBaseUrl(year, semester) {
	const semesterPrefix =
		semester.toLowerCase() === 'u' ? 'sum' : semester.toLowerCase();

	return `https://odtuclass${year}${semesterPrefix}.metu.edu.tr`;
}

export class ODTUClassClient {
	constructor(year, semester) {
		const resolved = (!year || !semester) ? resolveAcademicTerm() : { year, semester };
		this.year = resolved.year;
		this.semester = resolved.semester;
		this.baseUrl = makeBaseUrl(this.year, this.semester);

		this.cookies = {};
		this.sesskey = null;
		this.userId = null;
		this.username = null;
	}

	_cookieStr() {
		return Object.entries(this.cookies)
			.map(([key, value]) => `${key}=${value}`)
			.join('; ');
	}

	_collectCookies(response) {
		const setCookie = response.headers['set-cookie'];

		if (!setCookie) return;

		for (const cookie of setCookie) {
			const [nameValue] = cookie.split(';');
			const separator = nameValue.indexOf('=');

			if (separator <= 0) continue;

			const name = nameValue.slice(0, separator).trim();
			const value = nameValue.slice(separator + 1).trim();

			this.cookies[name] = value;
		}
	}

	async request(method, url, data = null, options = {}) {
		const headers = {
			'User-Agent': 'odtuclass-sync/1.0',
			Accept: 'application/json, text/javascript, */*; q=0.01',
			'X-Requested-With': 'XMLHttpRequest',
		};

		const cookieStr = this._cookieStr();

		if (cookieStr) {
			headers.Cookie = cookieStr;
		}

		if (options.json) {
			headers['Content-Type'] = 'application/json';
		}

		const config = {
			method,
			url,
			headers,
			maxRedirects: 0,
			validateStatus: () => true,
		};

		if (data !== null) {
			config.data = data;
		}

		if (options.params) {
			config.params = options.params;
		}

		if (options.responseType) {
			config.responseType = options.responseType;
		}

		const response = await axios(config);

		this._collectCookies(response);

		let currentResponse = response;
		let currentUrl = url;
		let redirectCount = 0;

		while (
			currentResponse.status >= 300 &&
			currentResponse.status < 400 &&
			redirectCount < 5
		) {
			const location = currentResponse.headers.location;
			if (!location) break;

			const redirectUrl = new URL(location, currentUrl).href;
			const redirectHeaders = {
				'User-Agent': 'odtuclass-sync/1.0',
				Accept: 'application/json, text/javascript, */*; q=0.01',
			};

			const cookies = this._cookieStr();
			if (
				cookies &&
				new URL(redirectUrl).origin === new URL(this.baseUrl).origin
			) {
				redirectHeaders.Cookie = cookies;
			}

			const redirectConfig = {
				method: 'GET',
				url: redirectUrl,
				headers: redirectHeaders,
				maxRedirects: 0,
				validateStatus: () => true,
			};

			if (options.responseType) {
				redirectConfig.responseType = options.responseType;
			}

			currentResponse = await axios(redirectConfig);
			this._collectCookies(currentResponse);
			currentUrl = redirectUrl;
			redirectCount++;
		}

		if (currentResponse.status >= 400) {
			throw new Error(
				`HTTP ${currentResponse.status}: ${currentResponse.statusText}`,
			);
		}

		currentResponse.finalUrl = currentUrl;

		return currentResponse;
	}
}

export async function apiCall(client, methodName, args) {
	const response = await client.request(
		'POST',
		`${client.baseUrl}/lib/ajax/service.php`,
		[
			{
				index: 0,
				methodname: methodName,
				args,
			},
		],
		{
			json: true,
			params: {
				sesskey: client.sesskey,
				info: methodName,
			},
		},
	);

	const data = response.data;

	if (!Array.isArray(data)) {
		throw new Error('Unexpected response from Moodle API.');
	}

	const result = data[0];

	if (result.error) {
		const exception = result.exception || {};

		throw new Error(
			exception.message || 'Moodle API call failed.',
		);
	}

	return result.data !== undefined ? result.data : result;
}
