async function main() {
  const API_BASE = 'https://app.coursedog.com/api/v1/cm/ramapo_banner_ethos';
  const HEADERS = {
    'x-requested-with': 'catalog',
    'referer': 'https://catalog.ramapo.edu/',
    'origin': 'https://catalog.ramapo.edu',
    'accept': 'application/json, text/plain, */*',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  const res = await fetch(`${API_BASE}/courses/search/%24filters`, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({
      skip: 0,
      limit: 10,
      columns: ["name", "code", "longName"]
    }),
  });
  const data = await res.json();
  console.log(data);
}
main();
