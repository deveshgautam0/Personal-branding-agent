import moment from 'moment';
import jsonfile from 'jsonfile';
import random from 'random';
import fs from 'fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_COMMIT_COUNT = 1700;

const DATA_PATH = 'data.json';
const COMMIT_MESSAGE = 'commit';

async function runGit(args, env = {}) {
  // Runs plain git commands (safe for backdated commits).
  // Uses execFile so we don't go through a shell.
  return execFileAsync('git', args, {
    env: { ...process.env, ...env },
    stdio: 'pipe'
  });
}

function clampInt(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function formatGitDate(dateMoment) {
  // Git-compatible: YYYY-MM-DDTHH:mm:ssZZ
  return dateMoment.format('YYYY-MM-DDTHH:mm:ssZZ');
}

/**
 * Pick a weekday index (0=Sunday..6=Saturday) with ~75% Mon-Fri.
 * We'll weight Mon-Fri each higher than Sat/Sun.
 */
function pickWeightedWeekday() {
  // Target: about 75% weekdays (Mon-Fri)
  // Split weekdays probability across 5 days equally.
  // Remaining 25% spread across Sat/Sun equally.
  const weekdayWeight = 0.75 / 5; // Mon-Fri each
  const weekendWeight = 0.25 / 2; // Sat/Sun each

  const weights = [weekendWeight, weekdayWeight, weekdayWeight, weekdayWeight, weekdayWeight, weekdayWeight, weekendWeight];
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < 7; i++) {
    acc += weights[i];
    if (r <= acc) return i;
  }
  return 1; // fallback Monday
}

/**
 * Create a biased random schedule that includes:
 * - mostly weekdays
 * - ~15% commits clustered (2-5 commits on same day)
 * - leaving some weeks with zero commits (by skipping random weeks)
 */
function generateDateSchedule(startMoment, endMoment) {
  // Work in whole days for clustering & week gaps.
  const startDay = startMoment.clone().startOf('day');
  const endDay = endMoment.clone().startOf('day');

  const totalDays = endDay.diff(startDay, 'days');
  if (totalDays <= 0) throw new Error('Invalid date range computed');

  const daysWithCommits = new Map(); // dayIndex -> number of commits

  const totalCommits = REPO_COMMIT_COUNT;

  // Decide which commits are part of clusters.
  const clusterCommitTotal = Math.floor(totalCommits * 0.15); // ~15%
  const remainingCommits = totalCommits - clusterCommitTotal;

  // Add clustered days: create 2-5 commits on the same day.
  let clusteredSoFar = 0;
  let safety = 0;

  while (clusteredSoFar < clusterCommitTotal && safety < 100000) {
    safety++;
    const clusterSize = random.int(2, 5);

    if (clusteredSoFar + clusterSize > clusterCommitTotal) {
      // Reduce last cluster size so we hit target.
      const adjusted = clampInt(clusterCommitTotal - clusteredSoFar, 2, 5);
      if (adjusted < 2) break;
      const dayIndex = pickRandomEligibleDayIndex(startDay, totalDays, pickWeightedWeekday);
      daysWithCommits.set(dayIndex, (daysWithCommits.get(dayIndex) || 0) + adjusted);
      clusteredSoFar += adjusted;
      continue;
    }

    const dayIndex = pickRandomEligibleDayIndex(startDay, totalDays, pickWeightedWeekday);
    daysWithCommits.set(dayIndex, (daysWithCommits.get(dayIndex) || 0) + clusterSize);
    clusteredSoFar += clusterSize;
  }

  // Add remaining singletons (or multiple separated days) with weekday bias
  // but also leave some weeks empty by skipping random weeks.
  let singlesSoFar = 0;
  safety = 0;

  // We will occasionally "skip" weeks by sampling days with a rejection method.
  // Choose a week gap probability so some weeks have zero commits.
  const skipWeekProbability = 0.35; // tune for realism

  while (singlesSoFar < remainingCommits && safety < 200000) {
    safety++;

    const dayIndex = pickRandomEligibleDayIndexWithWeekSkips(
      startDay,
      totalDays,
      pickWeightedWeekday,
      skipWeekProbability
    );

    // ensure not too many commits in one day beyond clusters: allow, but it should be rare.
    // We'll keep it naturally controlled by mostly using single commits here.
    daysWithCommits.set(dayIndex, (daysWithCommits.get(dayIndex) || 0) + 1);
    singlesSoFar++;
  }

  // Convert dayIndex->count map into a list of day entries with total commits check.
  const totalGenerated = Array.from(daysWithCommits.values()).reduce((a, b) => a + b, 0);
  if (totalGenerated !== totalCommits) {
    // Adjust deterministically if off-by due to break conditions
    // by trimming or adding random days.
    const diff = totalCommits - totalGenerated;

    if (diff > 0) {
      let add = diff;
      let iter = 0;
      while (add > 0 && iter < 200000) {
        iter++;
        const dayIndex = pickRandomEligibleDayIndexWithWeekSkips(startDay, totalDays, pickWeightedWeekday, skipWeekProbability);
        daysWithCommits.set(dayIndex, (daysWithCommits.get(dayIndex) || 0) + 1);
        add--;
      }
    } else if (diff < 0) {
      let remove = -diff;
      // create list of day indices repeated by count for easy removal
      const expanded = [];
      for (const [dayIndex, count] of daysWithCommits.entries()) {
        for (let i = 0; i < count; i++) expanded.push(dayIndex);
      }
      // remove random occurrences
      while (remove > 0 && expanded.length > 0) {
        const idx = random.int(0, expanded.length - 1);
        const dayIndex = expanded[idx];
        expanded.splice(idx, 1);
        const cur = daysWithCommits.get(dayIndex) || 0;
        if (cur <= 1) daysWithCommits.delete(dayIndex);
        else daysWithCommits.set(dayIndex, cur - 1);
        remove--;
      }
    }
  }

  // Now build concrete timestamps for each commit on that day.
  const dateStrings = [];
  for (const [dayIndex, count] of daysWithCommits.entries()) {
    const dayMoment = startDay.clone().add(dayIndex, 'days');
    for (let i = 0; i < count; i++) {
      // Random hour/min/sec so not all at midnight
      const hour = random.int(0, 23);
      const minute = random.int(0, 59);
      const second = random.int(0, 59);
      const ts = dayMoment.clone().hour(hour).minute(minute).second(second);
      dateStrings.push(formatGitDate(ts));
    }
  }

  // Ensure exactly 1700.
  if (dateStrings.length !== totalCommits) {
    throw new Error(`Generated ${dateStrings.length} commits, expected ${totalCommits}`);
  }

  // Sort chronologically (oldest first). Dates are git-formatted, so string compare
  // may work, but safer to sort by moment time.
  dateStrings.sort((a, b) => moment(a, 'YYYY-MM-DDTHH:mm:ssZZ').valueOf() - moment(b, 'YYYY-MM-DDTHH:mm:ssZZ').valueOf());

  return dateStrings;
}

function pickRandomEligibleDayIndex(startDay, totalDays, weekdayPickerFn) {
  // Pick day by selecting a target weekday and then choosing a random occurrence.
  const targetWeekday = weekdayPickerFn(); // 0..6
  const candidates = [];

  // Search a subset for performance (still fine for 3 years).
  for (let i = 0; i < totalDays; i++) {
    const d = startDay.clone().add(i, 'days');
    if (d.day() === targetWeekday) candidates.push(i);
  }

  if (candidates.length === 0) return random.int(0, totalDays - 1);
  return candidates[random.int(0, candidates.length - 1)];
}

function pickRandomEligibleDayIndexWithWeekSkips(startDay, totalDays, weekdayPickerFn, skipWeekProbability) {
  // Week skip: reject days that fall into a "skipped" week.
  // Determine week index relative to startDay.
  // We'll retry a few times to avoid infinite loop.
  const maxTries = 1000;

  for (let t = 0; t < maxTries; t++) {
    const dayIndex = random.int(0, totalDays - 1);
    const day = startDay.clone().add(dayIndex, 'days');
    const weekIndex = Math.floor(dayIndex / 7);
    const shouldSkip = Math.random() < skipWeekProbability;

    if (shouldSkip) continue;

    // weekday bias check: if weekday is far from expected, reject sometimes.
    const weekday = day.day(); // 0..6
    const expectedWeekday = weekdayPickerFn();

    // Accept with higher chance when weekday matches expected.
    const accept = weekday === expectedWeekday ? 0.9 : 0.35;
    if (Math.random() <= accept) return dayIndex;
  }

  // Fallback
  return random.int(0, totalDays - 1);
}

async function safeWriteJson(filePath, data) {
  // Ensure file exists (jsonfile.writeFile will create, but keep it safe).
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function main() {
  try {
    // Ensure we are in a git repo (pre-cloned target).
    await runGit(['rev-parse', '--is-inside-work-tree']);

    const now = moment();
    const start = moment(now).subtract(3, 'years');

    // Generate dates according to requirements.
    const dateStrings = generateDateSchedule(start, now);

    // Ensure data.json exists and starts as {} if missing.
    const dataPath = 'data.json';
    if (!fs.existsSync(dataPath)) {
      await safeWriteJson(dataPath, {});
    }

    console.log(`Starting: generating ${REPO_COMMIT_COUNT} backdated commits...`);

    for (let i = 0; i < dateStrings.length; i++) {
      const dateString = dateStrings[i];

      // Requirement: write that date string as data.json content.
      // jsonfile.writeFile will serialize the JS value; writing a string is fine.
      await jsonfile.writeFile(DATA_PATH, dateString);

      // Stage.
      await runGit(['add', DATA_PATH]);

      // Commit with backdated timestamps.
      const commitEnv = {
        GIT_AUTHOR_DATE: dateString,
        GIT_COMMITTER_DATE: dateString
      };

      console.log(`[${i + 1}/${REPO_COMMIT_COUNT}] Committing: ${dateString}`);

      await runGit(['commit', '--date', dateString, '-m', COMMIT_MESSAGE], commitEnv);
    }

    console.log('All commits created. Pushing once...');
    await runGit(['push']);
    console.log('Push complete.');
  } catch (err) {
    console.error('Script failed:', err);
    process.exitCode = 1;
  }
}

main();
