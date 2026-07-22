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

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ardiannurcahya-profile-stats",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} for ${url}: ${await response.text()}`);
  }
  return response.json();
}

async function githubGraphql(query, variables) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required to calculate review contributions and rank");
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
    throw new Error(`GitHub returned incomplete search results for: ${query}`);
  }
  return Number(result.total_count);
}

async function searchCount(query) {
  const result = await githubApi("/search/issues", { q: query, per_page: 1 });
  return requireCompleteSearch(result, query);
}

async function fetchReviewContributions() {
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
  if (!data.user) {
    throw new Error(`GitHub GraphQL returned no user for ${username}`);
  }
  return Number(data.user.contributionsCollection.totalPullRequestReviewContributions);
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
  // Formula used by GitHub Readme Stats for all-time commits.
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
  const levels = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];
  return levels[thresholds.findIndex((threshold) => percentile <= threshold)];
}

async function collectData() {
  const [user, allRepositories, commits, pullRequests, issues, reviews] = await Promise.all([
    githubApi(`/users/${username}`),
    fetchRepositories(),
    githubApi("/search/commits", { q: `author:${username}`, per_page: 1 }),
    searchCount(`author:${username} type:pr`),
    searchCount(`author:${username} type:issue`),
    fetchReviewContributions(),
  ]);
  requireCompleteSearch(commits, `author:${username}`);
  const repositories = allRepositories.filter((repository) => !repository.fork && !repository.archived);
  const stats = {
    commits: Number(commits.total_count),
    pullRequests,
    issues,
    reviews,
    repositories: Number(user.public_repos),
    stars: repositories.reduce((sum, repository) => sum + Number(repository.stargazers_count), 0),
    followers: Number(user.followers),
  };
  stats.rank = calculateRank(stats);

  const languages = new Map();
  for (const repository of repositories) {
    const repositoryLanguages = await githubApi(`/repos/${repository.full_name}/languages`);
    for (const [language, bytes] of Object.entries(repositoryLanguages)) {
      languages.set(language, (languages.get(language) || 0) + Number(bytes));
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

function cardShell(title, body, description) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="200" viewBox="0 0 340 200" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(description)}</desc>
  <style>
    .text { font: 600 13px 'Segoe UI', Ubuntu, sans-serif; fill: #c9d1d9; }
    .label { font: 400 12px 'Segoe UI', Ubuntu, sans-serif; fill: #8b949e; }
    .title { font: 600 18px 'Segoe UI', Ubuntu, sans-serif; fill: #58a6ff; }
    .value { font: 600 14px 'Segoe UI', Ubuntu, sans-serif; fill: #f0f6fc; }
  </style>
  <rect x="0.5" y="0.5" width="339" height="199" rx="6" fill="#0d1117" stroke="#30363d"/>
  <text x="24" y="34" class="title">${escapeXml(title)}</text>
${body}
</svg>
`;
}

function renderStats(stats) {
  const rows = [
    ["Commits found", stats.commits, "Pull requests", stats.pullRequests],
    ["Public repos", stats.repositories, "Issues opened", stats.issues],
    ["Stars earned", stats.stars, "Followers", stats.followers],
  ];
  const body = rows
    .flatMap(([leftLabel, leftValue, rightLabel, rightValue], index) => {
      const y = 69 + index * 37;
      return [
        `  <text x="24" y="${y}" class="label">${leftLabel}</text>`,
        `  <text x="145" y="${y}" text-anchor="end" class="value">${leftValue}</text>`,
        `  <text x="184" y="${y}" class="label">${rightLabel}</text>`,
        `  <text x="316" y="${y}" text-anchor="end" class="value">${rightValue}</text>`,
      ];
    })
    .concat([
      '  <line x1="24" y1="162" x2="316" y2="162" stroke="#21262d"/>',
      '  <text x="24" y="184" class="label">Estimated rank</text>',
      `  <text x="316" y="184" text-anchor="end" class="value">${escapeXml(stats.rank)}</text>`,
    ])
    .join("\n");
  return cardShell(
    `${username}'s GitHub Stats`,
    body,
    "GitHub activity found by public API search and a rank calculated with the GitHub Readme Stats formula.",
  );
}

function renderLanguages(languages) {
  const sortedLanguages = [...languages.entries()].sort((left, right) => right[1] - left[1]);
  const topLanguages = sortedLanguages.slice(0, 5);
  const totalBytes = sortedLanguages.reduce((sum, [, bytes]) => sum + bytes, 0);
  if (!topLanguages.length || totalBytes <= 0) {
    throw new Error("GitHub returned no public repository language data");
  }

  const body = ['  <rect x="24" y="51" width="292" height="8" rx="4" fill="#21262d"/>'];
  let x = 24;
  for (const [language, bytes] of topLanguages) {
    const width = (292 * bytes) / totalBytes;
    body.push(
      `  <rect x="${x.toFixed(2)}" y="51" width="${width.toFixed(2)}" height="8" fill="${languageColors[language] || "#8b949e"}"/>`,
    );
    x += width;
  }
  topLanguages.forEach(([language, bytes], index) => {
    const y = 87 + index * 24;
    const percentage = ((bytes / totalBytes) * 100).toFixed(1);
    const color = languageColors[language] || "#8b949e";
    body.push(
      `  <circle cx="29" cy="${y - 4}" r="5" fill="${color}"/>`,
      `  <text x="43" y="${y}" class="text">${escapeXml(language)}</text>`,
      `  <text x="316" y="${y}" text-anchor="end" class="label">${percentage}%</text>`,
    );
  });
  return cardShell(
    "Most Used Languages",
    body.join("\n"),
    "Top languages by bytes across public, non-fork, non-archived repositories.",
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
console.log(`Generated public GitHub stats for ${username}: ${JSON.stringify(stats)}`);
