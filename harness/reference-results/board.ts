// Independent reference reduction. No production reader/reducer imports.
// Callers supply rows decoded by this reference program from raw public evidence.
import { DatabaseSync } from "node:sqlite";

export interface ReferenceSession {
  key: string;
  contract: string;
  community: string;
  song: string;
  learner: string;
  period: number;
  activity: number;
  grader: string;
  scoring: string;
  policy: string;
  status: number;
  verified: boolean;
  outcomes: { ordinal: number; status: number; grade: number | null }[];
}
export interface ReferencePolicyDocument {
  activity: number;
  graders: string[];
  scoringPolicies: string[];
  terminalStatuses: number[];
  minScoreBps: number;
  maxUnmeasuredBps: number;
}
export interface ReferencePolicy {
  contract: string;
  hash: string;
  period: number;
  document?: ReferencePolicyDocument;
}
export interface ReferenceEligibility {
  community: string;
  learner: string;
  effectiveAt: number;
  order: string;
  eligible: boolean;
}

export function referenceBoards(
  sessions: readonly ReferenceSession[],
  policies: readonly ReferencePolicy[],
  eligibility: readonly ReferenceEligibility[],
  evaluationTimestamp: number,
) {
  if (
    !Number.isSafeInteger(evaluationTimestamp) ||
    evaluationTimestamp < 1793552400
  )
    throw Error("reference_invalid_evaluation");
  const period = Math.floor((evaluationTimestamp - 1793552400) / 86400);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE sessions(k TEXT PRIMARY KEY,contract TEXT,community TEXT,song TEXT,
        learner TEXT,period INTEGER,activity INTEGER,grader TEXT,scoring TEXT,
        policy TEXT,status INTEGER,verified INTEGER);
      CREATE TABLE outcomes(k TEXT,ordinal INTEGER,status INTEGER,grade INTEGER,
        PRIMARY KEY(k,ordinal));
      CREATE TABLE policies(contract TEXT,hash TEXT,period INTEGER,activity INTEGER,
        graders TEXT,scorings TEXT,statuses TEXT,min_score INTEGER,max_missing INTEGER,
        resolved INTEGER,
        PRIMARY KEY(contract,period));
      CREATE TABLE eligibility(community TEXT,learner TEXT,effective INTEGER,
        sequence TEXT,eligible INTEGER);
    `);
    const putSession = db.prepare(
      "INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const putOutcome = db.prepare("INSERT INTO outcomes VALUES(?,?,?,?)");
    const putPolicy = db.prepare(
      "INSERT INTO policies VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    const putEligibility = db.prepare(
      "INSERT INTO eligibility VALUES(?,?,?,?,?)",
    );
    for (const s of sessions) {
      putSession.run(
        s.key,
        s.contract,
        s.community,
        s.song,
        s.learner.toLowerCase(),
        s.period,
        s.activity,
        s.grader.toLowerCase(),
        s.scoring,
        s.policy,
        s.status,
        Number(s.verified),
      );
      for (const o of s.outcomes)
        putOutcome.run(s.key, o.ordinal, o.status, o.grade);
    }
    for (const p of policies) {
      const d = p.document;
      putPolicy.run(
        p.contract,
        p.hash,
        p.period,
        d?.activity ?? -1,
        JSON.stringify(d?.graders.map((x) => x.toLowerCase()) ?? []),
        JSON.stringify(d?.scoringPolicies ?? []),
        JSON.stringify(d?.terminalStatuses ?? []),
        d?.minScoreBps ?? 10001,
        d?.maxUnmeasuredBps ?? -1,
        Number(!!d),
      );
    }
    for (const e of eligibility)
      putEligibility.run(
        e.community,
        e.learner.toLowerCase(),
        e.effectiveAt,
        e.order,
        Number(e.eligible),
      );
    // Gap-and-island windows derive streaks; SQL RANK preserves shared ranks
    // and gaps. This deliberately does not use the production Set/loop reducer.
    const qualification = `
      WITH totals AS (
        SELECT k,COUNT(*) AS n,SUM(status=4) AS missing,
          SUM(CASE WHEN status=1 THEN grade ELSE 0 END) AS points
        FROM outcomes GROUP BY k
      ), qualified AS (
        SELECT s.* FROM sessions s JOIN totals t ON t.k=s.k
        JOIN policies p ON p.contract=s.contract AND p.hash=s.policy
          AND p.period=(SELECT MAX(p2.period) FROM policies p2
            WHERE p2.contract=s.contract AND p2.period<=s.period)
        WHERE s.verified=1 AND p.resolved=1 AND s.period<=? AND s.activity=p.activity
          AND s.grader IN(SELECT value FROM json_each(p.graders))
          AND s.scoring IN(SELECT value FROM json_each(p.scorings))
          AND s.status IN(SELECT value FROM json_each(p.statuses))
          AND t.n>t.missing AND t.points/(t.n-t.missing)>=p.min_score
          AND t.missing*10000<=p.max_missing*t.n
      ), scopes AS (
        SELECT 'community:'||community AS board,community,learner,period FROM qualified
        UNION ALL
        SELECT 'song:'||song AS board,community,learner,period FROM qualified
      ), days AS (
        SELECT DISTINCT board,community,learner,period FROM scopes
      )`;
    const rows = db
      .prepare(
        `${qualification}, islands AS (
        SELECT *,period-ROW_NUMBER() OVER(PARTITION BY board,learner ORDER BY period) AS island
        FROM days
      ), runs AS (
        SELECT board,community,learner,island,COUNT(*) AS length,MAX(period) AS last
        FROM islands GROUP BY board,community,learner,island
      ), metrics AS (
        SELECT board,community,learner,SUM(length) AS days,MAX(length) AS best,
          MAX(CASE WHEN last IN(?,?) THEN length ELSE 0 END) AS current,
          COALESCE((SELECT eligible FROM eligibility e WHERE e.community=r.community
            AND e.learner=r.learner AND e.effective<=?
            ORDER BY e.effective DESC,e.sequence DESC LIMIT 1),1) AS eligible
        FROM runs r GROUP BY board,community,learner
      ), ranked AS (
        SELECT board,learner,RANK() OVER(PARTITION BY board ORDER BY current DESC,best DESC) AS rank
        FROM metrics WHERE eligible=1
      )
      SELECT m.board,m.learner,m.days,m.current,m.best,m.eligible,r.rank
      FROM metrics m LEFT JOIN ranked r ON r.board=m.board AND r.learner=m.learner
      ORDER BY m.board,m.learner
    `,
      )
      .all(period, period, period - 1, evaluationTimestamp);
    const days = db
      .prepare(
        `${qualification}
      SELECT board,learner,period FROM days ORDER BY board,learner,period
    `,
      )
      .all(period);
    const scores = db
      .prepare(
        `SELECT s.k AS key,COUNT(o.ordinal) AS lines,
      SUM(CASE WHEN o.status=4 THEN 1 ELSE 0 END) AS unmeasured,
      CASE WHEN s.verified=1 AND COUNT(o.ordinal)>SUM(CASE WHEN o.status=4 THEN 1 ELSE 0 END)
        THEN SUM(CASE WHEN o.status=1 THEN o.grade ELSE 0 END)/
          (COUNT(o.ordinal)-SUM(CASE WHEN o.status=4 THEN 1 ELSE 0 END)) ELSE NULL END AS scoreBps
      FROM sessions s LEFT JOIN outcomes o ON o.k=s.k GROUP BY s.k ORDER BY s.k`,
      )
      .all();
    return {
      rows: rows.map((row) => ({ ...row })),
      days: days.map((row) => ({ ...row })),
      scores: scores.map((row) => ({ ...row })),
    };
  } finally {
    db.close();
  }
}
