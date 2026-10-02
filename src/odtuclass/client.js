import axios from 'axios';

export function makeBaseUrl(year, semester) {
	const semesterPrefix =
		semester.toLowerCase() === 'u' ? 'sum' : semester.toLowerCase();

	return `https://odtuclass${year}${semesterPrefix}.metu.edu.tr`;
}

export class ODTUClassClient {
	constructor(year, semester) {
		this.year = year;
		this.semester = semester;
		this.baseUrl = makeBaseUrl(year, semester);

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

		const response = await axios(config);

		this._collectCookies(response);

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.location;

			if (location) {
				const redirectUrl = new URL(location, url).href;

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

				const redirected = await axios({
					method: 'GET',
					url: redirectUrl,
					headers: redirectHeaders,
					maxRedirects: 0,
					validateStatus: () => true,
				});

				this._collectCookies(redirected);

				if (redirected.status >= 400) {
					throw new Error(
						`HTTP ${redirected.status}: ${redirected.statusText}`,
					);
				}

				redirected.finalUrl = redirectUrl;
				return redirected;
			}
		}

		if (response.status >= 400) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		response.finalUrl = response.config.url;

		return response;
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
