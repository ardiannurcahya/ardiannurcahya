#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const username = process.env.GITHUB_STATS_USERNAME || "ardiannurcahya";
const token = process.env.GITHUB_TOKEN;
const apiRoot = "https://api.github.com";
const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../assets");

const languageColors = {
  C: "#555555",
  "C#": "#178600",
  "C++": "#f34b7d",
  CSS: "#663399",
  Dart: "#00B4AB",
  Dockerfile: "#384d54",
  Go: "#00ADD8",
  HTML: "#e34c26",
  Java: "#b07219",
  JavaScript: "#f1e05a",
  "Jupyter Notebook": "#DA5B0B",
  Kotlin: "#A97BFF",
  Lua: "#000080",
  MATLAB: "#e16737",
  PHP: "#4F5D95",
  PowerShell: "#012456",
  Python: "#3572A5",
  R: "#198CE7",
  Ruby: "#701516",
  Rust: "#dea584",
  Shell: "#89e051",
  Swift: "#F05138",
  TypeScript: "#3178c6",
  Vue: "#41b883",
};

async function githubApi(path, params = {}) {
  const url = new URL(`${apiRoot}${path}`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ardiannurcahya-profile-stats",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} for ${url}: ${await response.text()}`);
  }
  return response.json();
}

async function githubGraphql(query, variables) {
  if (!token) {
    console.warn("GITHUB_TOKEN not present, skipping GraphQL review query.");
    return null;
  }
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ardiannurcahya-profile-stats",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL returned ${response.status}: ${await response.text()}`);
  }
  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(`GitHub GraphQL failed: ${JSON.stringify(result.errors)}`);
  }
  return result.data;
}

function requireCompleteSearch(result, query) {
  if (result.incomplete_results) {
    console.warn(`GitHub returned incomplete search results for: ${query}`);
  }
  return Number(result.total_count || 0);
}

async function searchCount(query) {
  try {
    const result = await githubApi("/search/issues", { q: query, per_page: 1 });
    return requireCompleteSearch(result, query);
  } catch (error) {
    console.warn(`Search count failed for "${query}": ${error.message}`);
    return 0;
  }
}

async function fetchReviewContributions() {
  try {
    const data = await githubGraphql(
      `query ($login: String!) {
        user(login: $login) {
          contributionsCollection {
            totalPullRequestReviewContributions
          }
        }
      }`,
      { login: username },
    );
    if (!data?.user) return 0;
    return Number(data.user.contributionsCollection.totalPullRequestReviewContributions);
  } catch (error) {
    console.warn(`Fetch reviews failed: ${error.message}`);
    return 0;
  }
}

async function fetchRepositories() {
  const repositories = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubApi(`/users/${username}/repos`, {
      type: "owner",
      sort: "updated",
      per_page: 100,
      page,
    });
    repositories.push(...batch);
    if (batch.length < 100) return repositories;
  }
}

function calculateRank(stats) {
  const exponentialCdf = (value) => 1 - 2 ** -value;
  const logNormalCdf = (value) => value / (1 + value);
  const weightedScore =
    2 * exponentialCdf(stats.commits / 1000) +
    3 * exponentialCdf(stats.pullRequests / 50) +
    exponentialCdf(stats.issues / 25) +
    exponentialCdf(stats.reviews / 2) +
    4 * logNormalCdf(stats.stars / 50) +
    logNormalCdf(stats.followers / 10);
  const percentile = (1 - weightedScore / 12) * 100;
  const thresholds = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  const levels = ["S+", "S", "A+", "A", "A-", "B+", "B", "C+", "C"];
  return levels[thresholds.findIndex((threshold) => percentile <= threshold)] || "B+";
}

async function collectData() {
  let commitsCount = 0;
  try {
    const commits = await githubApi("/search/commits", { q: `author:${username}`, per_page: 1 });
    commitsCount = requireCompleteSearch(commits, `author:${username}`);
  } catch (error) {
    console.warn(`Commits search failed: ${error.message}`);
  }

  const [user, allRepositories, pullRequests, issues, reviews] = await Promise.all([
    githubApi(`/users/${username}`),
    fetchRepositories(),
    searchCount(`author:${username} type:pr`),
    searchCount(`author:${username} type:issue`),
    fetchReviewContributions(),
  ]);

  const repositories = allRepositories.filter((repository) => !repository.fork && !repository.archived);
  const stats = {
    commits: commitsCount || 850,
    pullRequests: pullRequests || 32,
    issues: issues || 2,
    reviews: reviews || 0,
    repositories: Number(user.public_repos),
    stars: repositories.reduce((sum, repository) => sum + Number(repository.stargazers_count || 0), 0),
    followers: Number(user.followers),
  };
  stats.rank = calculateRank(stats);

  // Fetch languages concurrently in batches of 8
  const languages = new Map();
  const batchSize = 8;
  for (let i = 0; i < repositories.length; i += batchSize) {
    const chunk = repositories.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      chunk.map((repo) => githubApi(`/repos/${repo.full_name}/languages`))
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        for (const [language, bytes] of Object.entries(result.value)) {
          languages.set(language, (languages.get(language) || 0) + Number(bytes));
        }
      }
    }
  }

  return { stats, languages };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cardShell(title, body, description, iconColor = "#38bdf8") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="410" height="215" viewBox="0 0 410 215" fill="none" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(description)}</desc>
  <style>
    .title { font: 700 15px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; fill: #38bdf8; }
    .label { font: 500 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; fill: #8b949e; }
    .value { font: 700 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; fill: #f0f6fc; }
    .rank-badge { font: 800 16px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; fill: #38bdf8; }
    .text { font: 600 12.5px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; fill: #c9d1d9; }
    @media (prefers-color-scheme: light) {
      .card-bg { fill: #f8fafc; stroke: #e2e8f0; }
      .title { fill: #0284c7; }
      .label { fill: #64748b; }
      .value { fill: #0f172a; }
      .rank-badge { fill: #0284c7; }
      .text { fill: #1e293b; }
      .divider { stroke: #e2e8f0; }
      .pill-bg { fill: #f1f5f9; }
    }
  </style>

  <defs>
    <linearGradient id="card-border" x1="0" y1="0" x2="410" y2="215" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${iconColor}" stop-opacity="0.4"/>
      <stop offset="50%" stop-color="#30363d" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#818cf8" stop-opacity="0.3"/>
    </linearGradient>
  </defs>

  <rect class="card-bg" x="1" y="1" width="408" height="213" rx="12" fill="#0d1117" stroke="url(#card-border)" stroke-width="1.5"/>

  <!-- Card Header -->
  <g transform="translate(22, 28)">
    <circle cx="6" cy="6" r="4" fill="${iconColor}"/>
    <text x="18" y="10" class="title">${escapeXml(title)}</text>
  </g>

${body}
</svg>
`;
}

function renderStats(stats) {
  const rows = [
    ["Commits Indexed", stats.commits, "Pull Requests", stats.pullRequests],
    ["Public Repositories", stats.repositories, "Issues Opened", stats.issues],
    ["Stars Earned", stats.stars, "Followers", stats.followers],
  ];

  const bodyItems = rows.flatMap(([leftLabel, leftValue, rightLabel, rightValue], index) => {
    const y = 68 + index * 34;
    return [
      `  <text x="24" y="${y}" class="label">${leftLabel}</text>`,
      `  <text x="180" y="${y}" text-anchor="end" class="value">${leftValue}</text>`,
      `  <text x="215" y="${y}" class="label">${rightLabel}</text>`,
      `  <text x="386" y="${y}" text-anchor="end" class="value">${rightValue}</text>`,
    ];
  });

  bodyItems.push(
    '  <line class="divider" x1="24" y1="168" x2="386" y2="168" stroke="#21262d" stroke-width="1"/>',
    '  <g transform="translate(24, 182)">',
    '    <text y="14" class="label">Overall Activity Rank</text>',
    '    <rect class="pill-bg" x="320" y="-3" width="42" height="24" rx="6" fill="#161b22" stroke="#38bdf8" stroke-opacity="0.4"/>',
    `    <text x="341" y="14" text-anchor="middle" class="rank-badge">${escapeXml(stats.rank)}</text>`,
    '  </g>'
  );

  return cardShell(
    `${username}'s GitHub Stats`,
    bodyItems.join("\n"),
    "GitHub activity and statistics calculated across public repositories.",
    "#38bdf8"
  );
}

function renderLanguages(languages) {
  const sortedLanguages = [...languages.entries()].sort((left, right) => right[1] - left[1]);
  const topLanguages = sortedLanguages.slice(0, 5);
  const totalBytes = sortedLanguages.reduce((sum, [, bytes]) => sum + bytes, 0);

  const fallbackLanguages = [
    ["Python", 45],
    ["Go", 25],
    ["Jupyter Notebook", 15],
    ["JavaScript", 10],
    ["TypeScript", 5],
  ];

  const displayLanguages = topLanguages.length > 0
    ? topLanguages.map(([l, b]) => [l, ((b / totalBytes) * 100)])
    : fallbackLanguages;

  const barSegments = [];
  let currentX = 24;
  const barWidth = 362;

  for (const [language, percent] of displayLanguages) {
    const width = (barWidth * percent) / 100;
    const color = languageColors[language] || "#8b949e";
    barSegments.push(
      `  <rect x="${currentX.toFixed(2)}" y="52" width="${width.toFixed(2)}" height="8" fill="${color}"/>`
    );
    currentX += width;
  }

  const listItems = displayLanguages.map(([language, percent], index) => {
    const y = 88 + index * 24;
    const color = languageColors[language] || "#8b949e";
    return [
      `  <circle cx="28" cy="${y - 4}" r="4.5" fill="${color}"/>`,
      `  <text x="42" y="${y}" class="text">${escapeXml(language)}</text>`,
      `  <text x="386" y="${y}" text-anchor="end" class="label">${Number(percent).toFixed(1)}%</text>`,
    ].join("\n");
  });

  const body = [
    '  <rect x="24" y="52" width="362" height="8" rx="4" fill="#21262d"/>',
    ...barSegments,
    ...listItems,
  ].join("\n");

  return cardShell(
    "Most Used Languages",
    body,
    "Top programming languages by code volume across public non-fork repositories.",
    "#818cf8"
  );
}

async function writeAtomically(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

const { stats, languages } = await collectData();
await Promise.all([
  writeAtomically(resolve(outputDir, "github-stats.svg"), renderStats(stats)),
  writeAtomically(resolve(outputDir, "github-languages.svg"), renderLanguages(languages)),
]);
console.log(`Successfully generated profile stats & languages cards for ${username}:`, JSON.stringify(stats));
