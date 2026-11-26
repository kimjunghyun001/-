import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand
} from "@aws-sdk/client-s3";

import express from "express";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;

const r2Endpoint =
    process.env.R2_ENDPOINT;

const r2AccessKeyId =
    process.env.R2_ACCESS_KEY_ID;

const r2SecretAccessKey =
    process.env.R2_SECRET_ACCESS_KEY;

const r2BucketName =
    process.env.R2_BUCKET_NAME;

const r2Client = new S3Client({
    region: "auto",

    endpoint:
        r2Endpoint,

    credentials: {
        accessKeyId:
            r2AccessKeyId,

        secretAccessKey:
            r2SecretAccessKey
    }
});
async function cleanupPendingProblemImage(req, imageKey) {
    const cleanKey = safeText(imageKey);

    const pendingKeys =
        Array.isArray(req.session?.pendingProblemImageKeys)
            ? req.session.pendingProblemImageKeys
            : [];

    if (
        !cleanKey ||
        !cleanKey.startsWith("problem-images/") ||
        !pendingKeys.includes(cleanKey)
    ) {
        return false;
    }

    const user = req.currentUser;

    /*
     * 이미 오답노트 / 복습완료 / 휴지통 중 하나에서
     * 사용 중인 사진인지 확인한다.
     *
     * 사용 중이라면 저장된 문제 사진을 절대 삭제하지 않고
     * pending 표시만 제거한다.
     */
    if (user) {
        ensureUserShape(user);

        const imageIsReferenced =
            [
                ...(user.notes || []),
                ...(user.solvedNotes || []),
                ...(user.trashNotes || [])
            ].some(
                (note) =>
                    safeText(
                        note.problemImageKey
                    ) === cleanKey
            );

        if (imageIsReferenced) {
            req.session.pendingProblemImageKeys =
                pendingKeys.filter(
                    (key) => key !== cleanKey
                );

            console.log(
                "R2 ORPHAN CLEANUP SKIPPED - IMAGE REFERENCED:",
                cleanKey
            );

            return false;
        }
    }

    /*
     * 어디에서도 사용하지 않는
     * 이번 업로드 사진만 실제 삭제한다.
     */
    await r2Client.send(
        new DeleteObjectCommand({
            Bucket: r2BucketName,
            Key: cleanKey
        })
    );

    req.session.pendingProblemImageKeys =
        pendingKeys.filter(
            (key) => key !== cleanKey
        );

    console.log(
        "R2 ORPHAN IMAGE DELETED:",
        cleanKey
    );

    return true;
}
console.log(
    "R2 ENDPOINT:",
    process.env.R2_ENDPOINT
);

console.log(
    "R2 BUCKET:",
    process.env.R2_BUCKET_NAME
);

console.log("API KEY 확인:", apiKey ? "불러오기 성공" : "불러오기 실패");
import session from "express-session";
import { installCommerce } from "./scorepath-commerce/commerce.mjs";
import sessionFileStoreFactory from "session-file-store";
import { createNeonSyncBridge } from "./scorepath-neon-runtime/bridge.mjs";
import { createNeonSessionStore } from "./scorepath-neon-runtime/session-store.mjs";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
// 안전한 기본 HTTP 헤더 및 API 출처 검사 (기존 로그인·결제 로직은 그대로 유지)
app.disable("x-powered-by");
app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.set("Permissions-Policy", "microphone=(), geolocation=()");
    if (req.path.startsWith("/api/")) {
        res.set("Cache-Control", "no-store");
        res.set("Pragma", "no-cache");
        const method = req.method;
        if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
            const fetchSite = String(req.get("sec-fetch-site") || "");
            if (fetchSite === "cross-site") {
                return res.status(403).json({ error: "외부 사이트 요청은 허용하지 않습니다." });
            }
            const origin = req.get("origin");
            if (origin) {
                try {
                    const url = new URL(origin);
                    if (!["http:", "https:"].includes(url.protocol) || url.host !== req.get("host")) {
                        return res.status(403).json({ error: "요청 출처가 일치하지 않습니다." });
                    }
                } catch {
                    return res.status(403).json({ error: "요청 출처를 확인할 수 없습니다." });
                }
            }
        }
    }
    next();
});
let aiStats = {
    total: 0,
    mediumUsed: 0
};
console.log("🔥 서버 새 버전 실행");
const PORT = Number(process.env.PORT || 3000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, "public");
// 배포시 영구 디스크를 별도 연결할 때만 사용. 기존 개발 데이터는 이동하지 않음.
const scorePathConfiguredDataDir = String(process.env.SCOREPATH_DATA_DIR || "").trim();
if (scorePathConfiguredDataDir && !path.isAbsolute(scorePathConfiguredDataDir)) {
    throw new Error("SCOREPATH_DATA_DIR는 절대경로로 지정해야 합니다.");
}
const dataDir = scorePathConfiguredDataDir
    ? path.resolve(scorePathConfiguredDataDir)
    : path.join(__dirname, "data");
const dbPath = path.join(dataDir, "db.json");
// Optional Postgres-backed beta runtime; requires explicit activation after verified import.
const scorePathNeonMode = String(process.env.SCOREPATH_STORAGE_MODE || '').toLowerCase() === 'neon';
if (process.env.NODE_ENV === 'production' && !scorePathNeonMode) {
    throw new Error('ScorePath 공개 배포는 영구 DB(Neon 모드) 연결이 필요합니다. 로컬 JSON 데이터가 사라질 수 있어 시작을 중단합니다.');
}
const scorePathNeon = scorePathNeonMode ? createNeonSyncBridge(process.env.DATABASE_URL) : null;
if (scorePathNeon) {
    scorePathNeon.ping(); // fail closed until promote.cjs --activate succeeded
    console.log('[ScorePath Neon] 사용자·결제·AI 사용량을 영구 PostgreSQL 저장소에 연결했습니다.');
}
app.locals.scorePathNeon = scorePathNeon;
if (scorePathConfiguredDataDir && !scorePathNeonMode && !fs.existsSync(dbPath)) {
    throw new Error("지정된 영구 저장소에 db.json이 없습니다. 기존 DB를 안전하게 이전·검증하기 전 서버 시작을 중단합니다.");
}

// =====================================
// ScorePath 21-353
// 서비스 전체 AI 예산 관리
// =====================================

// 기본 예산
// 하루 1달러, 한 달 10달러
// 추후 .env에서 변경 가능

function reserveScorePathAiBudgetV01(provider) {
    if (scorePathNeon) {
        const reservation = scorePathNeon.reserveBudget(provider, {
            daily: process.env.SCOREPATH_AI_DAILY_BUDGET_USD ?? 2,
            monthly: process.env.SCOREPATH_AI_MONTHLY_BUDGET_USD ?? 10,
            reserve: provider === 'gemini' ?
                (process.env.SCOREPATH_AI_GEMINI_RESERVE_USD ?? 0.02) :
                (process.env.SCOREPATH_AI_OPENAI_RESERVE_USD ?? 0.05)
        });
        console.log('SCOREPATH AI BUDGET (Neon):', reservation);
        return;
    }

    const numberSetting = (name, fallback) => {

        const value = Number(
            process.env[name] ?? fallback
        );

        if (
            !Number.isFinite(value) ||
            value <= 0
        ) {
            throw new Error(
                `잘못된 AI 예산 설정: ${name}`
            );
        }

        // 소수점 계산 오차 방지
        return Math.round(value * 1000000);
    };

     // =====================================
    // ScorePath 21-385
    // AI 테스트 예산 확대
    // =====================================

    const dailyLimit = numberSetting(
        "SCOREPATH_AI_DAILY_BUDGET_USD",
        2
    );

    const monthlyLimit = numberSetting(
        "SCOREPATH_AI_MONTHLY_BUDGET_USD",
        10
    );

    // 호출 1회당 미리 예약할 예산
    // 실제 비용보다 보수적으로 설정
    const reservation =
        provider === "gemini"

            ? numberSetting(
                "SCOREPATH_AI_GEMINI_RESERVE_USD",
                0.02
            )

            : numberSetting(
                "SCOREPATH_AI_OPENAI_RESERVE_USD",
                0.05
            );

    // 한국시간 기준 날짜
    const day = new Date(
        Date.now() + 9 * 3600000
    ).toISOString().slice(0, 10);

    const month = day.slice(0, 7);

    const file = path.join(
        dataDir,
        `ai-budget-${month}.json`
    );

    fs.mkdirSync(dataDir, {
        recursive: true
    });

    // =====================================
    // 기본 예산 기록
    // =====================================

    let ledger = {
        month,
        monthReservedMicroUsd: 0,
        days: {}
    };

    // 기존 사용량 복원
    if (fs.existsSync(file)) {

        ledger = JSON.parse(
            fs.readFileSync(file, "utf8")
        );

        if (
            ledger?.month !== month ||
            !Number.isSafeInteger(
                ledger.monthReservedMicroUsd
            ) ||
            !ledger.days ||
            typeof ledger.days !== "object"
        ) {
            throw new Error(
                "AI 예산 기록 파일에 오류가 있습니다. 호출을 차단합니다."
            );
        }
    }

    const spentToday =
        ledger.days[day] ?? 0;

    const spentMonth =
        ledger.monthReservedMicroUsd;

    if (
        !Number.isSafeInteger(spentToday) ||
        spentToday < 0 ||
        spentMonth < 0
    ) {
        throw new Error(
            "AI 예산 기록이 올바르지 않습니다. 호출을 차단합니다."
        );
    }

    // =====================================
    // 예산 초과 확인
    // =====================================

    if (
        spentToday + reservation > dailyLimit ||
        spentMonth + reservation > monthlyLimit
    ) {
        throw new Error(
            "ScorePath 전체 AI 사용 예산에 도달했습니다. 잠시 후 이용해 주세요."
        );
    }

    // =====================================
    // 사용량 예약 및 저장
    // =====================================

    ledger.days[day] =
        spentToday + reservation;

    ledger.monthReservedMicroUsd =
        spentMonth + reservation;

    const temp =
        `${file}.${process.pid}.tmp`;

    fs.writeFileSync(
        temp,
        JSON.stringify(ledger),
        {
            encoding: "utf8",
            mode: 0o600
        }
    );

    fs.renameSync(temp, file);

    console.log(
        "SCOREPATH AI BUDGET:",
        {
            day,
            provider,

            todayReservedUsd:
                ledger.days[day] / 1000000,

            monthReservedUsd:
                ledger.monthReservedMicroUsd /
                1000000
        }
    );
}

// =====================================
// ScorePath 21-158
// AI 사용량 집계 및 로컬 기록
// =====================================

// 서버 실행 중의 누적 통계
const scorePathAiUsageTotalsV01 = {

    gemini: {
        calls: 0,
        withUsage: 0,
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0
    },

    openai: {
        calls: 0,
        withUsage: 0,
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0
    }
};


// =====================================
// 실제 API 토큰 사용량 기록
// =====================================

function recordScorePathAiUsageV01({
    provider,
    model,
    purpose,
    httpOk,
    usage,
    imageCount = 0
}) {

    // 사용량 기록 오류 때문에
    // AI 분석 자체가 실패하지 않도록 보호
    try {

        const count = (value) =>
            Number.isSafeInteger(value) &&
            value >= 0
                ? value
                : null;

        const isGemini =
            provider === "gemini";

        const usagePresent =
            usage !== null &&
            typeof usage === "object" &&
            !Array.isArray(usage);

        // =====================================
        // Gemini / GPT 사용량 형식 통일
        // =====================================

        const item = {

            timestamp:
                new Date().toISOString(),

            provider,
            model,
            purpose,
            imageCount: Number.isInteger(imageCount) ? Math.max(0, Math.min(3, imageCount)) : 0,

            httpOk:
                httpOk === true,

            usagePresent,

            // 입력 토큰
            inputTokens: count(
                isGemini
                    ? usage?.promptTokenCount
                    : usage?.prompt_tokens
            ),

            // 출력 토큰
            outputTokens: count(
                isGemini
                    ? usage?.candidatesTokenCount
                    : usage?.completion_tokens
            ),

            // 추론 토큰
            thinkingTokens: count(
                isGemini
                    ? usage?.thoughtsTokenCount
                    : usage
                        ?.completion_tokens_details
                        ?.reasoning_tokens
            ),

            // 캐시된 입력 토큰
            cachedInputTokens: count(
                isGemini
                    ? usage?.cachedContentTokenCount
                    : usage
                        ?.prompt_tokens_details
                        ?.cached_tokens
            ),

            // API에서 보고한 전체 토큰
            totalTokens: count(
                isGemini
                    ? usage?.totalTokenCount
                    : usage?.total_tokens
            )
        };

        // =====================================
        // 서버 실행 중 누적 집계
        // =====================================

        const totals =
            scorePathAiUsageTotalsV01[provider];

        if (totals) {

            totals.calls += 1;

            if (usagePresent) {
                totals.withUsage += 1;
            }

            for (const key of [

                "inputTokens",
                "outputTokens",
                "thinkingTokens",
                "cachedInputTokens",
                "totalTokens"

            ]) {

                totals[key] +=
                    item[key] ?? 0;
            }
        }

        // =====================================
        // ScorePath 21-354
        // 실제 토큰 기준 AI 원가 추정
        // =====================================

        // 가격: USD / 100만 토큰
        const prices =
    model === "gemini-3.1-flash-lite"

        ? {
            input: 0.25,
            cached: 0.025,
            output: 1.50
        }

        : model === "gpt-5.4-mini"

            ? {
                input: 0.75,
                cached: 0.075,
                output: 4.50
            }

            : model === "gpt-6.1-terra"

                ? {
                    input: 1.00,
                    cached: 0.05,
                    output: 5.00
                }

            : model === "gpt-6-luna"

                ? {
                    input: 0.10,
                    cached: 0.01,
                    output: 0.50
                }

                : null;

        item.estimatedCostUsd = null;

        if (
            prices &&
            item.inputTokens !== null &&
            item.outputTokens !== null
        ) {

            const cached = Math.min(
                item.cachedInputTokens || 0,
                item.inputTokens
            );

            // Gemini는 Thinking 토큰 별도 합산
            // GPT는 출력 토큰에 추론 토큰 포함
            const output = isGemini

                ? item.outputTokens +
                    (item.thinkingTokens || 0)

                : item.outputTokens;

            item.estimatedCostUsd = Number(
                (
                    (
                        (item.inputTokens - cached) *
                        prices.input +

                        cached * prices.cached +

                        output * prices.output
                    ) / 1000000
                ).toFixed(8)
            );

            if (totals) {

                totals.estimatedCostUsd = Number(
                    (
                        (totals.estimatedCostUsd || 0) +
                        item.estimatedCostUsd
                    ).toFixed(8)
                );
            }
        }

        // =====================================
        // 날짜별 사용량 파일 저장
        // =====================================

        // UTC 날짜 기준
        const logPath =
            path.join(
                dataDir,

                `ai-usage-${
                    item.timestamp.slice(0, 10)
                }.jsonl`
            );

        // 사용자 문제, 답안,
        // 개인정보는 기록하지 않는다.
        if (scorePathNeon) {
            scorePathNeon.appendUsage(item);
        } else {
            fs.appendFileSync(logPath, JSON.stringify(item) + "\n", {
                encoding: "utf-8", mode: 0o600
            });
        }

        // =====================================
        // 콘솔에 누적 사용량 출력
        // =====================================

        console.log(

            "SCOREPATH AI USAGE TOTALS:",

            JSON.stringify(
                scorePathAiUsageTotalsV01
            )
        );

    } catch (error) {

        console.error(
            "SCOREPATH AI USAGE LOG FAILED:",
            error.message
        );
    }
}

// =====================================
// ScorePath 21-355
// Gemini / GPT 호출 전 전체 예산 검사
// =====================================

// 원래 fetch 함수 보관
const scorePathOriginalFetchV01 =
    globalThis.fetch.bind(globalThis);

// 이 server.js에서 실행되는 fetch 호출에
// AI 예산 보호 장치를 적용한다.
const fetch = async (...args) => {

    const url = String(
        args[0]?.url ||
        args[0] ||
        ""
    );

    const provider =
        url.startsWith(
            "https://generativelanguage.googleapis.com/"
        )

            ? "gemini"

            : url.startsWith(
                "https://api.openai.com/"
            )

                ? "openai"

                : "";

    // Gemini / GPT 호출만 보호
    if (provider) {

        reserveScorePathAiBudgetV01(
            provider
        );
    }

    // 예산 검사 통과 후 실제 요청
    return scorePathOriginalFetchV01(
        ...args
    );
};

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

if (!scorePathNeon) {
// =====================================
// ScorePath 21-152
// DB 초기화 방지 및 날짜별 백업
// =====================================

// 기존 DB가 한 번이라도 만들어졌는지 기록
const dbMarkerPath =
    path.join(
        dataDir,
        ".scorepath-db-initialized"
    );

// =====================================
// 1. DB 파일이 존재하지 않는 경우
// =====================================

if (!fs.existsSync(dbPath)) {

    // 기존 데이터가 있었던 흔적 확인
    const existingDataEvidence = [

        dbMarkerPath,

        path.join(
            dataDir,
            "db.recovery.json"
        ),

        path.join(
            dataDir,
            "db.backup.json"
        ),

        path.join(
            dataDir,
            "db.backup.jsony"
        ),

        path.join(
            dataDir,
            "backups"
        )

    ].some(
        (file) =>
            fs.existsSync(file)
    );

    // 기존 DB가 있었을 가능성이 있다면
    // 절대로 빈 DB를 새로 만들지 않는다.
    if (existingDataEvidence) {

        throw new Error(
            "db.json이 없습니다. " +
            "기존 학습 데이터 보호를 위해 " +
            "빈 DB 생성 및 서버 시작을 중단합니다."
        );
    }

    // 정말 처음 설치한 경우에만 DB 생성
    fs.writeFileSync(
        dbPath,

        JSON.stringify(
            { users: [] },
            null,
            2
        ),

        {
            encoding: "utf-8",
            flag: "wx",
            mode: 0o600
        }
    );
}

// =====================================
// 2. 서버 시작 전 DB 검증
// =====================================

const startupDb =
    JSON.parse(
        fs.readFileSync(
            dbPath,
            "utf-8"
        )
    );

if (
    !startupDb ||
    !Array.isArray(startupDb.users)
) {

    throw new Error(
        "DB 구조 오류: 서버 시작을 중단합니다."
    );
}

// =====================================
// 3. 서버 시작 날짜별 백업
// =====================================

const startupBackupDir =
    path.join(
        dataDir,
        "backups"
    );

fs.mkdirSync(
    startupBackupDir,
    {
        recursive: true
    }
);

const startupBackupPath =
    path.join(

        startupBackupDir,

        `db-${new Date().toISOString().slice(0, 10)}.json`
    );

// 같은 날짜의 백업은 덮어쓰지 않는다.
if (!fs.existsSync(startupBackupPath)) {

    fs.copyFileSync(
        dbPath,

        startupBackupPath,

        fs.constants.COPYFILE_EXCL
    );
}

// =====================================
// 4. DB 초기화 이력 생성
// =====================================

if (!fs.existsSync(dbMarkerPath)) {

    fs.writeFileSync(
        dbMarkerPath,
        "initialized\n",
        {
            flag: "wx"
        }
    );
}

 } // end local JSON startup/backup; Neon mode does not create empty local data

// ScorePath는 프런트엔드와 API를 같은 출처에서 제공한다.
// 전체 출처 CORS 허용을 제거하고 기본 보안 헤더 일부를 적용한다.
app.disable("x-powered-by");
app.use((req, res, next) => {
    if (req.path.startsWith("/api/auth/")) {
        res.set("Cache-Control", "no-store");
    }
    next();
});
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// =====================================
// ScorePath 21-356
// 배포 환경의 세션 보안
// =====================================

const scorePathIsProductionV01 =
    process.env.NODE_ENV === "production";

const scorePathSessionSecretV01 =
    process.env.SESSION_SECRET || "";

if (
    scorePathIsProductionV01 &&
    scorePathSessionSecretV01.length < 32
) {
    throw new Error(
        "배포 환경에는 32자 이상의 SESSION_SECRET이 필요합니다."
    );
}

if (
    scorePathIsProductionV01 &&
    process.env.SCOREPATH_TRUST_PROXY === "true"
) {
    app.set("trust proxy", 1);
}

// express-session 기본 MemoryStore 대신 파일 세션 저장소 사용.
// 운영 서버에서는 data 폴더를 영구 디스크에 두거나 관리형 세션 저장소로 전환해야 한다.
const ScorePathFileStore = sessionFileStoreFactory(session);
const scorePathSessionStore = scorePathNeon
    ? createNeonSessionStore(session, process.env.DATABASE_URL)
    : (() => {
        const scorePathSessionDir = path.join(dataDir, "sessions");
        fs.mkdirSync(scorePathSessionDir, { recursive: true, mode: 0o700 });
        return new ScorePathFileStore({
            path: scorePathSessionDir,
            ttl: 7 * 24 * 60 * 60,
            reapInterval: 60 * 60
        });
    })();

app.use(
    session({
        store: scorePathSessionStore,
        name: "scorepath.sid",

        secret:
            scorePathSessionSecretV01 ||
            "scorepath-local-dev-only-session-secret",

        resave: false,
        saveUninitialized: false,

        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: scorePathIsProductionV01,
            maxAge: 1000 * 60 * 60 * 24 * 7
        }
    })
);

const DEFAULT_SUBJECTS = ["국어", "영어", "수학", "사회", "과학"];

app.use(express.static(publicDir));

// =====================================
// ScorePath 21-379
// 무료 + 유료 9,900원 요금제
// =====================================

const PLAN_RULES = {
    free: {
        aiDaily: 2,
        advancedDaily: 0,

        storageLimit: 50,
        similarCount: 1,

        reviewEnabled: false,
        duplicateAnalyze: false,
        advancedEnabled: false
    },

    // 기존 5,900원 플랜 호환용
    // 신규 가입자에게는 표시하지 않음
    premium5900: {
        aiDaily: 15,
        advancedDaily: 0,

        storageLimit: 300,
        similarCount: 2,

        reviewEnabled: true,
        duplicateAnalyze: true,
        advancedEnabled: false
    },

    // 기존 8,900원 테스트 계정 호환용
    premium8900: {
        aiDaily: 15,
        advancedDaily: 2,

        storageLimit: Infinity,
        similarCount: 2,

        reviewEnabled: true,
        duplicateAnalyze: true,
        advancedEnabled: true
    },

    // 새로운 정식 유료 플랜
    premium9900: {
        aiDaily: 15,
        advancedDaily: 2,

        storageLimit: Infinity,
        similarCount: 2,

        reviewEnabled: true,
        duplicateAnalyze: true,
        advancedEnabled: true
    }
};

function safeText(value) {
    return String(value || "").trim();
}

function safeParseAiJson(raw, label = "AI") {
    const original = safeText(raw);

    if (!original) {
        throw new Error(`${label} 응답 내용이 없습니다.`);
    }

    // 1. 정상 JSON
    try {
        return JSON.parse(original);
    } catch {}

    // 2. ```json ... ``` 제거
    const withoutFence = original
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

    try {
        return JSON.parse(withoutFence);
    } catch {}

    // 3. 앞뒤에 불필요한 문장이 붙은 경우
    const firstBrace = withoutFence.indexOf("{");
    const lastBrace = withoutFence.lastIndexOf("}");

    if (
        firstBrace !== -1 &&
        lastBrace !== -1 &&
        lastBrace > firstBrace
    ) {
        const candidate =
            withoutFence.slice(
                firstBrace,
                lastBrace + 1
            );

        try {
            return JSON.parse(candidate);
        } catch {}
    }

    console.error(`${label} JSON PARSE FAILED:`, original);

    throw new Error(
        `${label}의 JSON 형식이 올바르지 않습니다.`
    );
}


function getMultipleChoiceNumbers(problem = "") {
    const choiceMap = getChoiceMap(problem);

    return Object.keys(choiceMap)
        .filter((key) => /^\d+$/.test(key))
        .sort(
            (a, b) =>
                Number(a) - Number(b)
        );
}


function canonicalizeAiAnswer(
    answer,
    problem = ""
) {
    const text = safeText(answer);

    if (!text) {
        return "";
    }

    const choiceNumbers =
        getMultipleChoiceNumbers(problem);

    const isMultipleChoice =
        choiceNumbers.length >= 2;

    if (!isMultipleChoice) {
        return text;
    }

    const normalized =
        normalizeAnswer(text);

    // 객관식이면 실제 존재하는 선택지 번호만 허용
    if (
        /^\d+$/.test(normalized) &&
        choiceNumbers.includes(normalized)
    ) {
        return normalized;
    }

    console.warn(
        "INVALID MULTIPLE CHOICE ANSWER:",
        {
            rawAnswer: text,
            normalized,
            choiceNumbers
        }
    );

    return "";
}


function detectSolutionChoiceConflict(
    solution,
    finalAnswer,
    problem = ""
) {
    const choiceNumbers =
        getMultipleChoiceNumbers(problem);

    if (choiceNumbers.length < 2) {
        return false;
    }

    const answer =
        canonicalizeAiAnswer(
            finalAnswer,
            problem
        );

    if (!answer) {
        return true;
    }

    const text =
        safeText(solution);

    if (!text) {
        return false;
    }

    /*
     * 1. 풀이에서 명시적으로 말한
     * 선택지 번호를 검사한다.
     *
     * 예:
     * "정답은 ③"
     * "따라서 3번"
     * "4번이 정답"
     */
    const patterns = [
        /정답(?:은|이|:)?\s*[①②③④⑤⑥⑦⑧⑨]/g,
        /따라서\s*[①②③④⑤⑥⑦⑧⑨]/g,
        /그러므로\s*[①②③④⑤⑥⑦⑧⑨]/g,
        /[①②③④⑤⑥⑦⑧⑨]\s*번?(?:이|가)?\s*정답/g,

        /정답(?:은|이|:)?\s*([1-9])\s*번/g,
        /따라서\s*([1-9])\s*번/g,
        /그러므로\s*([1-9])\s*번/g,
        /([1-9])\s*번(?:이|가)?\s*(?:답|정답)/g
    ];

    const symbolMap = {
        "①": "1",
        "②": "2",
        "③": "3",
        "④": "4",
        "⑤": "5",
        "⑥": "6",
        "⑦": "7",
        "⑧": "8",
        "⑨": "9"
    };

    const detected = [];

    for (const pattern of patterns) {
        const matches =
            text.matchAll(pattern);

        for (const match of matches) {
            let value = "";

            const symbol =
                match[0].match(
                    /[①②③④⑤⑥⑦⑧⑨]/
                )?.[0];

            if (symbol) {
                value = symbolMap[symbol];
            } else if (match[1]) {
                value = match[1];
            }

            if (
                value &&
                choiceNumbers.includes(value)
            ) {
                detected.push(value);
            }
        }
    }

    if (detected.length > 0) {
        const solutionFinalAnswer =
            detected[detected.length - 1];

        if (solutionFinalAnswer !== answer) {
            console.warn(
                "SOLUTION ANSWER CONFLICT:",
                {
                    reason:
                        "explicit_choice_conflict",
                    finalAnswer: answer,
                    solutionFinalAnswer,
                    detected
                }
            );

            return true;
        }
    }

    /*
     * 2. 풀이 후반부의 명시적인 계산 결과가
     * 실제 선택지 값과 일치하는지 검사한다.
     *
     * 모든 중간 숫자를 검사하지 않는다.
     * 풀이의 마지막 부분만 대상으로 한다.
     *
     * 예:
     *
     * "... = -4/π × 1/12 = -1/3π가 아니라,
     * 최종 결과는 -1/4π"
     *
     * 같은 자기모순을 잡기 위한 보조 검사다.
     */
    const tail =
        text.slice(
            Math.max(
                0,
                text.length - 500
            )
        );

    /*
     * "=" 뒤에 나온 값 후보를 모은다.
     *
     * 너무 일반적인 숫자 추출은 하지 않는다.
     */
    const equationResultPattern =
        /=\s*([^=,\n。]+?)(?=\s*(?:=|,|\.|。|$))/g;

    const equationResults = [];

    for (
        const match of
        tail.matchAll(equationResultPattern)
    ) {
        const rawValue =
            safeText(match[1]).trim();

        if (!rawValue) {
            continue;
        }

        const mappedChoice =
            mapDerivedAnswerToChoice(
                rawValue,
                problem
            );

        if (mappedChoice) {
            equationResults.push({
                rawValue,
                mappedChoice
            });
        }
    }

    /*
     * 계산식에서 실제 선택지로 매핑 가능한
     * 결과가 하나라도 나왔는데,
     * 마지막 계산 결과가 최종 aiAnswer와
     * 다르면 의심 신호로 본다.
     */
    if (equationResults.length > 0) {
        const lastEquationResult =
            equationResults[
                equationResults.length - 1
            ];

        if (
            lastEquationResult.mappedChoice !==
            answer
        ) {
            console.warn(
                "SOLUTION CALCULATION CONFLICT:",
                {
                    reason:
                        "last_equation_result_conflict",
                    finalAnswer: answer,
                    solutionCalculatedAnswer:
                        lastEquationResult.mappedChoice,
                    rawValue:
                        lastEquationResult.rawValue,
                    equationResults
                }
            );

            return true;
        }
    }

    return false;
}

function normalizeDerivedAnswer(value) {
    let text = safeText(value);

    if (!text) {
        return "";
    }

    text = text
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[−–—]/g, "-")
        .replace(/×/g, "*")
        .replace(/÷/g, "/")
        .replace(/π/g, "pi")
        .replace(/[{}]/g, "")
        .replace(/\\left|\\right/g, "")
        .replace(/\\pi/g, "pi")
        .replace(/\\frac\s*\(([^()]+)\)\s*\(([^()]+)\)/g, "$1/$2")
        .replace(/\\frac\s*([^/]+)\s*([^/]+)/g, "$1/$2")
        .trim();

    // -1/(3pi) → -1/3pi
    // 1/(2pi)  → 1/2pi
    text = text.replace(
        /\/\(([-+]?[a-z0-9.*^]+)\)/g,
        "/$1"
    );

    // 앞뒤 불필요한 문장부호 제거
    text = text
        .replace(/^[=:]+/, "")
        .replace(/[.,。]+$/, "");

    return text;
}


function mapDerivedAnswerToChoice(
    derivedAnswer,
    problem = ""
) {
    const derived =
        safeText(derivedAnswer).trim();

    if (!derived) {
        return "";
    }

    const choiceMap =
        getChoiceMap(problem);

    const choiceNumbers =
        getMultipleChoiceNumbers(problem);

    if (choiceNumbers.length < 2) {
        return "";
    }

    /*
     * derivedAnswer는 기본적으로
     * "실제 계산 결과값"이다.
     *
     * 따라서 bare number:
     *   "2"
     *
     * 를 2번 선택지로 해석하면 안 된다.
     *
     * 아래처럼 명시적으로 선택지를
     * 표현한 경우에만 번호로 처리한다.
     *
     *   "②"
     *   "2번"
     *   "정답 2번"
     *   "답: 2번"
     */
    const circledMap = {
        "①": "1",
        "②": "2",
        "③": "3",
        "④": "4",
        "⑤": "5",
        "⑥": "6",
        "⑦": "7",
        "⑧": "8",
        "⑨": "9"
    };

    const circledMatch =
        derived.match(/[①②③④⑤⑥⑦⑧⑨]/);

    if (circledMatch) {
        const number =
            circledMap[circledMatch[0]];

        if (choiceNumbers.includes(number)) {
            return number;
        }
    }

    const explicitNumberMatch =
        derived.match(
            /^(?:(?:정답|답)\s*[:：]?\s*)?([1-9])\s*번(?:\s*(?:선택지)?)?$/
        );

    if (explicitNumberMatch) {
        const number =
            explicitNumberMatch[1];

        if (choiceNumbers.includes(number)) {
            return number;
        }
    }

    /*
     * 여기부터는 derivedAnswer를
     * 선택지 "번호"가 아니라
     * 선택지 "내용"과 비교한다.
     *
     * 예:
     *
     * derivedAnswer = "200"
     * ③ = "200"
     *
     * → 3 반환
     *
     * derivedAnswer = "2"
     * ③ = "2"
     *
     * → 3 반환
     */
    const normalizedDerived =
        normalizeDerivedAnswer(
            derived
        );

    for (const number of choiceNumbers) {
        const choiceValue =
            choiceMap[number];

        if (!choiceValue) {
            continue;
        }

        if (
            answersEquivalent(
                derived,
                choiceValue,
                ""
            )
        ) {
            return number;
        }

        const normalizedChoice =
            normalizeDerivedAnswer(
                choiceValue
            );

        if (
            normalizedDerived &&
            normalizedChoice &&
            normalizedDerived ===
                normalizedChoice
        ) {
            return number;
        }
    }

    /*
     * ㄱ / ㄴ / ㄷ 조합 문제
     */
    const normalizeStatements =
        (value) => {
            const matches =
                safeText(value)
                    .match(/[ㄱ-ㅎ]/g);

            if (!matches) {
                return "";
            }

            return [...new Set(matches)]
                .sort()
                .join("");
        };

    const derivedStatements =
        normalizeStatements(derived);

    if (derivedStatements) {
        for (const number of choiceNumbers) {
            const choiceValue =
                choiceMap[number];

            const choiceStatements =
                normalizeStatements(
                    choiceValue
                );

            if (
                choiceStatements &&
                choiceStatements ===
                    derivedStatements
            ) {
                return number;
            }
        }
    }

    return "";
}


function checkDerivedAnswerConsistency(
    aiAnswer,
    derivedAnswer,
    problem = ""
) {
    const choiceNumbers =
        getMultipleChoiceNumbers(problem);

    /*
     * 주관식은 아직 이 검사를
     * 객관식처럼 강제하지 않는다.
     */
    if (choiceNumbers.length < 2) {
        return {
            checked: false,
            conflict: false,
            derivedChoice: ""
        };
    }

    const finalAnswer =
        canonicalizeAiAnswer(
            aiAnswer,
            problem
        );

    const derivedChoice =
        mapDerivedAnswerToChoice(
            derivedAnswer,
            problem
        );

    /*
     * derivedAnswer를 선택지로
     * 안전하게 변환하지 못했다면
     * 억지로 충돌이라고 판단하지 않는다.
     *
     * 불필요한 GPT 호출을 막기 위함.
     */
    if (
        !finalAnswer ||
        !derivedChoice
    ) {
        return {
            checked: false,
            conflict: false,
            derivedChoice
        };
    }

    return {
        checked: true,

        conflict:
            finalAnswer !==
            derivedChoice,

        derivedChoice
    };
}

function normalizeAnswer(value) {
    let text = safeText(value)
        .toLowerCase()
        .trim();

    // 앞의 "정답:", "답:" 제거
    text = text.replace(/^(정답|답)\s*[:：]?\s*/g, "");

    // 객관식 원문자 → 일반 숫자
    const circledNumberMap = {
        "①": "1",
        "②": "2",
        "③": "3",
        "④": "4",
        "⑤": "5",
        "⑥": "6",
        "⑦": "7",
        "⑧": "8",
        "⑨": "9"
    };

    const firstChar = text.charAt(0);

    if (circledNumberMap[firstChar]) {
        // "②", "② 이산화탄소" 모두 "2"로 통일
        return circledNumberMap[firstChar];
    }

    // "2번", "2번 이산화탄소" → "2"
    const choiceMatch = text.match(/^([1-9])\s*번(?:\s|$)/);

    if (choiceMatch) {
        return choiceMatch[1];
    }

    // 단순 변수형 답: "x=4", "y = 7" → "4", "7"
const variableAnswerMatch = text.match(/^[a-z]\s*=\s*(.+)$/i);

if (variableAnswerMatch) {
    text = variableAnswerMatch[1].trim();
}

text = text
    .replace(/\s+/g, "")
    .replace(/,/g, "")
    .replace(/[°º]+$/g, "")
    .replace(/[.。]+$/g, "")
    .trim();

    // 분수: "1/2", "2/4" → "0.5"
const fractionMatch = text.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);

if (fractionMatch) {
    const numerator = Number(fractionMatch[1]);
    const denominator = Number(fractionMatch[2]);

    if (denominator !== 0) {
        text = String(numerator / denominator);
    }
}

// 퍼센트: "50%" → "0.5"
const percentMatch = text.match(/^(-?\d+(?:\.\d+)?)%$/);

if (percentMatch) {
    const percentValue = Number(percentMatch[1]);

    if (Number.isFinite(percentValue)) {
        text = String(percentValue / 100);
    }
}

// 숫자 + 선택적 단위의 불필요한 소수점 0 제거
const numericUnitMatch = text.match(
    /^(-?\d+(?:\.\d+)?)([a-z%²³]*)$/i
);

if (numericUnitMatch) {
    const number = Number(numericUnitMatch[1]);
    const unit = numericUnitMatch[2];

    if (Number.isFinite(number)) {
        text = String(number) + unit;
    }
}

return text;
}

function parseComparableQuantity(value) {
    let text = safeText(value)
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/,/g, "")
        .trim();

    // 지원 단위
    const unitMatch = text.match(
        /(mm|cm|km|mg|kg|ml|m|g|l)$/
    );

    if (!unitMatch) return null;

    const unit = unitMatch[1];

    // 뒤의 단위를 제거해서 숫자 부분만 가져오기
    const numberText = text.slice(0, -unit.length);

    let number = null;

    // 분수 + 단위: 1/4m, 2/5kg 등
    const fractionMatch = numberText.match(
        /^(-?\d+)\/(-?\d+)$/
    );

    if (fractionMatch) {
        const numerator = Number(fractionMatch[1]);
        const denominator = Number(fractionMatch[2]);

        if (denominator === 0) {
            return null;
        }

        number = numerator / denominator;
    } else {
        // 일반 숫자 + 단위: 0.25m, 25cm 등
        number = Number(numberText);
    }

    if (!Number.isFinite(number)) {
        return null;
    }

    const unitTable = {
        mm: { type: "length", factor: 0.001 },
        cm: { type: "length", factor: 0.01 },
        m:  { type: "length", factor: 1 },
        km: { type: "length", factor: 1000 },

        mg: { type: "mass", factor: 0.001 },
        g:  { type: "mass", factor: 1 },
        kg: { type: "mass", factor: 1000 },

        ml: { type: "volume", factor: 0.001 },
        l:  { type: "volume", factor: 1 }
    };

    const info = unitTable[unit];

    if (!info) {
        return null;
    }

    return {
        type: info.type,
        value: number * info.factor
    };
}

function getChoiceMap(problem = "") {
    const text = safeText(problem);
    const map = {};

    /*
     * ========================================
     * 1. 원문자 선택지
     * ========================================
     *
     * ① 사과
     * ② 배
     * ③ 포도
     */

    const symbols = [
        "①",
        "②",
        "③",
        "④",
        "⑤",
        "⑥",
        "⑦",
        "⑧",
        "⑨"
    ];

    for (
        let i = 0;
        i < symbols.length;
        i++
    ) {
        const symbol = symbols[i];

        const start =
            text.indexOf(symbol);

        if (start === -1) {
            continue;
        }

        let end = text.length;

        for (
            let j = i + 1;
            j < symbols.length;
            j++
        ) {
            const next =
                text.indexOf(
                    symbols[j],
                    start + 1
                );

            if (next !== -1) {
                end = next;
                break;
            }
        }

        let value =
            text
                .slice(
                    start + symbol.length,
                    end
                )
                .trim();

        value =
            value
                .split("\n")[0]
                .trim();

        if (!value) {
            continue;
        }

        const number =
            String(i + 1);

        map[symbol] = value;
        map[number] = value;
        map[`${number}번`] = value;
    }

    /*
     * ========================================
     * 2. 숫자형 선택지
     * ========================================
     *
     * 사진 추출 예:
     *
     * 1. 3.0
     * 2. 4.8
     * 3. 6.0
     * 4. 8.2
     *
     * 문제 번호:
     *
     * 6. 그림과 같은 RL 병렬회로에서...
     *
     * 같은 줄은 선택지로 포함하면 안 된다.
     */

    const lines =
        text.split(/\r?\n/);

    const numberedChoices = [];

    for (const line of lines) {
        const match =
            line.match(
                /^\s*([1-9])\s*[\.\)]\s*(.+?)\s*$/
            );

        if (!match) {
            continue;
        }

        numberedChoices.push({
            number: safeText(match[1]),
            value: safeText(match[2])
        });
    }

    /*
     * 선택지는 일반적으로
     * 1 → 2 → 3 → 4 ...
     * 처럼 연속해서 등장한다.
     *
     * 따라서 단독으로 앞에 있는
     *
     * 6. 문제 내용
     *
     * 같은 문제 번호는 버리고,
     * 1번부터 연속되는 선택지 묶음만 사용한다.
     */

    const sequentialChoices = [];

    let expectedNumber = 1;
    let sequenceStarted = false;

    for (const item of numberedChoices) {
        const number =
            Number(item.number);

        if (!sequenceStarted) {
            if (number !== 1) {
                continue;
            }

            sequenceStarted = true;
        }

        if (number !== expectedNumber) {
            /*
             * 이미 선택지 묶음이 시작됐는데
             * 번호가 연속되지 않으면 종료.
             */
            if (sequentialChoices.length >= 2) {
                break;
            }

            sequentialChoices.length = 0;
            sequenceStarted = false;
            expectedNumber = 1;

            continue;
        }

        sequentialChoices.push(item);
        expectedNumber += 1;
    }

    /*
     * 최소 2개의 연속 선택지가 있어야
     * 객관식 선택지로 인정한다.
     */

    if (sequentialChoices.length >= 2) {
        for (const item of sequentialChoices) {
            const number =
                item.number;

            const value =
                item.value;

            /*
             * ① 형식에서 이미 정상적으로
             * 얻은 값이 있으면 그것을 우선한다.
             */
            if (map[number]) {
                continue;
            }

            map[number] = value;
            map[`${number}번`] = value;

            const symbol =
                symbols[
                    Number(number) - 1
                ];

            if (symbol) {
                map[symbol] = value;
            }
        }
    }

    return map;
}

function parseNumberWithKoreanCounter(value) {
    const text = normalizeAnswer(value);

    const match = text.match(
        /^(-?\d+(?:\.\d+)?)(개|명|권|자루|마리|대|병|잔|장|켤레|벌|채|송이|포기|봉지|상자|통|팩|회|번)$/
    );

    if (!match) return null;

    const number = Number(match[1]);

    if (!Number.isFinite(number)) {
        return null;
    }

    return {
        value: number,
        counter: match[2]
    };
}

function answersEquivalent(a, b, problem = "") {
    const rawA = safeText(a).trim();
    const rawB = safeText(b).trim();

    const normalizedA = normalizeAnswer(a);
    const normalizedB = normalizeAnswer(b);

    if (!normalizedA || !normalizedB) {
        return false;
    }

    /*
     * ========================================
     * 0. 객관식 선택지 번호 보호
     * ========================================
     *
     * 객관식 문제에서는
     *
     * userAnswer = "1"
     * correctAnswer = "3"
     *
     * 같은 값은 각각 ①, ③을 뜻한다.
     *
     * 선택지 ①의 실제 값이 우연히 "3.0"이라고 해서
     * "1"과 "3"을 같은 답으로 판단하면 안 된다.
     *
     * 따라서 양쪽 모두 실제 존재하는 선택지 번호라면
     * 무조건 번호 자체를 비교한다.
     */

    const choiceMap =
        getChoiceMap(problem);

    const choiceNumbers =
        Object.keys(choiceMap)
            .filter((key) => /^\d+$/.test(key))
            .sort(
                (x, y) =>
                    Number(x) - Number(y)
            );

    const isMultipleChoice =
        choiceNumbers.length >= 2;

    const choiceSymbolMap = {
        "①": "1",
        "②": "2",
        "③": "3",
        "④": "4",
        "⑤": "5",
        "⑥": "6",
        "⑦": "7",
        "⑧": "8",
        "⑨": "9"
    };

    const getChoiceNumber = (raw, normalized) => {
        const first =
            safeText(raw).charAt(0);

        if (
            choiceSymbolMap[first] &&
            choiceNumbers.includes(
                choiceSymbolMap[first]
            )
        ) {
            return choiceSymbolMap[first];
        }

        const numberedMatch =
            safeText(raw).match(
                /^([1-9])\s*번(?:\s|$)/
            );

        if (
            numberedMatch &&
            choiceNumbers.includes(
                numberedMatch[1]
            )
        ) {
            return numberedMatch[1];
        }

        /*
         * 객관식 문제에서
         * "1", "2", "3"처럼 숫자만 들어온 경우도
         * 실제 존재하는 선택지 번호라면
         * 선택지 번호로 취급한다.
         */
        if (
            isMultipleChoice &&
            /^\d+$/.test(normalized) &&
            choiceNumbers.includes(normalized)
        ) {
            return normalized;
        }

        return null;
    };

    const choiceA =
        getChoiceNumber(
            rawA,
            normalizedA
        );

    const choiceB =
        getChoiceNumber(
            rawB,
            normalizedB
        );

    /*
     * 둘 다 선택지 번호라면
     * 선택지 내용으로 내려가지 않고
     * 번호 자체만 비교한다.
     */
    if (choiceA && choiceB) {
        return choiceA === choiceB;
    }

    /*
     * ========================================
     * 1. 일반 정규화 비교
     * ========================================
     */

    if (normalizedA === normalizedB) {
        return true;
    }

    /*
     * ========================================
     * 2. 숫자 ↔ 숫자 + 한국어 개수 단위
     * ========================================
     *
     * 예:
     * 5 ↔ 5개
     * 3 ↔ 3명
     */

    const koreanCounterA =
        parseNumberWithKoreanCounter(a);

    const koreanCounterB =
        parseNumberWithKoreanCounter(b);

    const plainNumberA =
        /^-?\d+(?:\.\d+)?$/.test(
            normalizedA
        )
            ? Number(normalizedA)
            : null;

    const plainNumberB =
        /^-?\d+(?:\.\d+)?$/.test(
            normalizedB
        )
            ? Number(normalizedB)
            : null;

    if (
        koreanCounterA &&
        plainNumberB !== null &&
        koreanCounterA.value ===
            plainNumberB
    ) {
        return true;
    }

    if (
        koreanCounterB &&
        plainNumberA !== null &&
        koreanCounterB.value ===
            plainNumberA
    ) {
        return true;
    }

    /*
     * ========================================
     * 3. 숫자 ↔ 숫자 + 단순 단위
     * ========================================
     *
     * 예:
     * 57600 ↔ 57600원
     * 5 ↔ 5A
     * 400 ↔ 400rpm
     */

    const parseSimpleNumberWithUnit =
        (value) => {
            const text =
                normalizeAnswer(value);

            const match =
                text.match(
                    /^([-+]?(?:\d+(?:\.\d+)?|\.\d+))(원|a|v|w|n|hz|rpm|pa|j|wh|kw|kw\/h|m\/s|m\/s²|m\/s\^2|km\/h|℃|°c|ω)?$/
                );

            if (!match) {
                return null;
            }

            return {
                value:
                    Number(match[1]),

                unit:
                    match[2] || ""
            };
        };

    const simpleUnitA =
        parseSimpleNumberWithUnit(a);

    const simpleUnitB =
        parseSimpleNumberWithUnit(b);

    if (
        simpleUnitA &&
        simpleUnitB &&
        Math.abs(
            simpleUnitA.value -
            simpleUnitB.value
        ) < 1e-9 &&
        (
            simpleUnitA.unit ===
                simpleUnitB.unit ||
            !simpleUnitA.unit ||
            !simpleUnitB.unit
        )
    ) {
        return true;
    }

    /*
     * ========================================
     * 4. 물리량 단위 동치 비교
     * ========================================
     *
     * 예:
     * 1m ↔ 100cm
     */

    const quantityA =
        parseComparableQuantity(a);

    const quantityB =
        parseComparableQuantity(b);

    if (
        quantityA &&
        quantityB &&
        quantityA.type ===
            quantityB.type &&
        Math.abs(
            quantityA.value -
            quantityB.value
        ) < 1e-9
    ) {
        return true;
    }

    /*
     * ========================================
     * 5. 선택지 번호 ↔ 실제 선택지 값
     * ========================================
     *
     * 여기까지 왔다는 것은
     * "양쪽 모두 선택지 번호"인 상황은 아니다.
     *
     * 따라서 한쪽만 선택지 번호이고
     * 다른 한쪽이 실제 값일 때만
     * 선택지 내용을 풀어서 비교한다.
     *
     * 예:
     * ③ ↔ 8
     * 2번 ↔ 산소
     */

    if (
        choiceA &&
        !choiceB
    ) {
        const choiceValue =
            choiceMap[choiceA];

        if (
            choiceValue &&
            answersEquivalent(
                choiceValue,
                b,
                ""
            )
        ) {
            return true;
        }
    }

    if (
        choiceB &&
        !choiceA
    ) {
        const choiceValue =
            choiceMap[choiceB];

        if (
            choiceValue &&
            answersEquivalent(
                a,
                choiceValue,
                ""
            )
        ) {
            return true;
        }
    }

    return false;
}

function ensureCorrectChoice(problem, correctAnswer) {
    if (!problem || !correctAnswer) return problem;

    const choiceRegex = /([①②③④⑤])\s*([^①②③④⑤\n]+)/g;
    const choices = [];

    let match;

    while ((match = choiceRegex.exec(problem)) !== null) {
        choices.push({
            symbol: match[1],
            value: match[2].trim(),
            full: match[0]
        });
    }

    // 객관식이 아니면 그대로
    if (choices.length < 2) {
        return problem;
    }

    // 비교용 정답
    let comparableCorrectAnswer = safeText(correctAnswer);

    // AI가 "② 선택지 문장"처럼 반환한 경우
    // 해당 번호의 실제 선택지 내용만 가져옴
   const answerSymbolMatch =
    comparableCorrectAnswer.match(/^([①②③④⑤])\s*(.*)$/);

if (answerSymbolMatch) {
    const symbol = answerSymbolMatch[1];
    const answerText = safeText(answerSymbolMatch[2]);

    // "④ k = 4"처럼 번호 + 실제 답 내용이 함께 있으면
    // 번호보다 실제 답 내용을 우선한다.
    if (answerText) {
        comparableCorrectAnswer = answerText;
    } else {
        // "④"처럼 번호만 온 경우에만 해당 선택지 내용을 사용한다.
        const matchedChoice = choices.find(
            (choice) => choice.symbol === symbol
        );

        if (matchedChoice) {
            comparableCorrectAnswer = matchedChoice.value;
        }
    }
}

    // 이미 실제 정답이 선택지에 있으면 수정 안 함
    const hasCorrectChoice = choices.some((choice) =>
        answersEquivalent(
            choice.value,
            comparableCorrectAnswer,
            problem
        )
    );

    if (hasCorrectChoice) {
        console.log("SIMILAR CHOICE OK:", {
            correctAnswer,
            comparableCorrectAnswer
        });

        return problem;
    }

    // 정답 위치가 매번 같지 않도록 선택지 하나 결정
    const targetIndex =
        Math.abs(
            [...String(problem)].reduce(
                (sum, ch) => sum + ch.charCodeAt(0),
                0
            )
        ) % choices.length;

    const target = choices[targetIndex];

    const replacement =
        `${target.symbol} ${comparableCorrectAnswer}`;

    const fixedProblem = problem.replace(
        target.full,
        replacement
    );

    console.warn("SIMILAR CHOICE FIXED:", {
        correctAnswer,
        comparableCorrectAnswer,
        oldChoice: target.full,
        newChoice: replacement
    });

    return fixedProblem;
}

function compareAnswers(aiAnswer, userCorrectAnswer, problem = "") {
    const ai = normalizeAnswer(aiAnswer);
    const user = normalizeAnswer(userCorrectAnswer);

    if (!ai) {
        return {
            verification: "uncertain",
            warning: "AI가 문제의 정답을 확정하지 못했습니다."
        };
    }

    if (!user) {
        return {
            verification: "uncertain",
            warning: `입력한 정답이 없습니다. AI 검증 정답: ${safeText(aiAnswer)}`
        };
    }

   if (answersEquivalent(aiAnswer, userCorrectAnswer, problem)) {
        return {
            verification: "match",
            warning: ""
        };
    }

    return {
        verification: "mismatch",
        warning: `⚠ 입력한 정답을 다시 확인해 주세요. AI 검증 정답: ${safeText(aiAnswer)}`
    };
}
function normalizeEmail(email) {
    return safeText(email).toLowerCase();
}

function todayString() {
    return new Date().toISOString().slice(0, 10);
}

function now() {
    return Date.now();
}

// =====================================
// ScorePath 21-150
// DB 읽기 실패 시 데이터 보호
// =====================================

function readDb(scope = null) {
    if (scorePathNeon) return scorePathNeon.readDb(scope);

    let parsed;

    try {

        const raw =
            fs.readFileSync(
                dbPath,
                "utf-8"
            );

        parsed =
            JSON.parse(raw);

    } catch (error) {

        console.error(
            "SCOREPATH DB READ FAILED:",
            error
        );

        // DB에 문제가 발생하면
        // 절대로 빈 DB를 반환하지 않는다.
        throw new Error(
            "DB를 읽을 수 없습니다. 저장을 중단했습니다. " +
            "data/db.json과 백업을 확인하세요."
        );
    }

    // =====================================
    // DB 기본 구조 검사
    // =====================================

    if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !Array.isArray(parsed.users)
    ) {

        throw new Error(
            "DB 구조가 올바르지 않습니다. 저장을 중단했습니다. " +
            "data/db.json을 확인하세요."
        );
    }

    return parsed;
}

// =====================================
// ScorePath 21-151
// 안전한 DB 저장 시스템
// =====================================

function writeDb(db) {
    if (scorePathNeon) return scorePathNeon.writeDb(db);

    // =====================================
    // 1. 저장할 데이터 구조 검사
    // =====================================

    if (
        !db ||
        !Array.isArray(db.users)
    ) {

        throw new Error(
            "저장할 DB 구조가 올바르지 않습니다."
        );
    }

    // =====================================
    // 2. 현재 DB 읽기
    // =====================================

    const currentRaw =
        fs.readFileSync(
            dbPath,
            "utf-8"
        );

    let current;

    try {

        current =
            JSON.parse(currentRaw);

    } catch {

        // 손상된 DB를 절대로 덮어쓰지 않는다.
        throw new Error(
            "현재 DB가 손상되어 저장을 중단했습니다."
        );
    }

    if (
        !current ||
        !Array.isArray(current.users)
    ) {

        throw new Error(
            "현재 DB 구조가 잘못되어 저장을 중단했습니다."
        );
    }

    // =====================================
    // 3. 동시 요청에 의한 덮어쓰기 방지
    // =====================================

    const diskRevision =
        Number(
            current._scorepathDbRevision || 0
        );

    const loadedRevision =
        Number(
            db._scorepathDbRevision || 0
        );

    if (
        !Number.isSafeInteger(diskRevision) ||
        diskRevision < 0 ||
        diskRevision !== loadedRevision
    ) {

        throw new Error(
            "다른 요청에서 DB가 변경되었습니다. " +
            "데이터를 보호하기 위해 저장을 중단했습니다."
        );
    }

    db._scorepathDbRevision =
        diskRevision + 1;

    const nextRaw =
        JSON.stringify(
            db,
            null,
            2
        );

    // =====================================
    // 4. 백업 및 임시 파일 경로
    // =====================================

    const recoveryPath =
        path.join(
            dataDir,
            "db.recovery.json"
        );

    const suffix =
        `${process.pid}-${Date.now()}-${randomUUID()}`;

    const backupTemp =
        path.join(
            dataDir,
            `.db-recovery-${suffix}.tmp`
        );

    const dbTemp =
        path.join(
            dataDir,
            `.db-new-${suffix}.tmp`
        );

    // =====================================
    // 5. 임시 파일에 안전하게 기록
    // =====================================

    function writeAndSync(
        filePath,
        content
    ) {

        const fd =
            fs.openSync(
                filePath,
                "wx",
                0o600
            );

        try {

            fs.writeFileSync(
                fd,
                content,
                "utf-8"
            );

            fs.fsyncSync(fd);

        } finally {

            fs.closeSync(fd);
        }
    }

    // =====================================
    // 6. 실제 저장
    // =====================================

    try {

        // 기존 정상 DB의 복구 파일 생성
        writeAndSync(
            backupTemp,
            currentRaw
        );

        fs.renameSync(
            backupTemp,
            recoveryPath
        );

        // 새 DB를 임시 파일에 먼저 기록
        writeAndSync(
            dbTemp,
            nextRaw
        );

         // =====================================
        // ScorePath
        // Windows DB 파일 교체 재시도
        // =====================================

        const maxRenameAttempts = 5;

        const waitBuffer =
            new Int32Array(
                new SharedArrayBuffer(4)
            );

        for (
            let attempt = 1;
            attempt <= maxRenameAttempts;
            attempt++
        ) {

            try {

                fs.renameSync(
                    dbTemp,
                    dbPath
                );

                break;

            } catch (error) {

                const retryable =
                    ["EPERM", "EACCES", "EBUSY"]
                        .includes(error.code);

                if (
                    !retryable ||
                    attempt === maxRenameAttempts
                ) {

                    throw error;
                }

                // Windows의 일시적인 파일 잠금 해제 대기
                Atomics.wait(
                    waitBuffer,
                    0,
                    0,
                    attempt * 100
                );
            }
        }

    } finally {

        // 실패했을 경우 남은 임시 파일 정리
        for (
            const file of
            [backupTemp, dbTemp]
        ) {

            if (fs.existsSync(file)) {

                try {

                    fs.unlinkSync(file);

                } catch {}
            }
        }
    }
}

function getPlanRule(plan) {
    return PLAN_RULES[plan] || PLAN_RULES.free;
}

// 문제 저장은 오답노트 + 정답(복습완료) 목록의 활성 저장 건수로 계산한다.
// 휴지통이나 풀이 이벤트 이력은 중복 집계를 피하기 위해 제외한다.
function getStoredProblemCountV01(user) {
    return (Array.isArray(user.notes) ? user.notes.length : 0) +
        (Array.isArray(user.solvedNotes) ? user.solvedNotes.length : 0);
}

function isAlreadyStoredProblemV01(user, identity) {
    return [
        ...(Array.isArray(user.notes) ? user.notes : []),
        ...(Array.isArray(user.solvedNotes) ? user.solvedNotes : [])
    ].some(note =>
        noteKey(
            note.subject,
            getProblemIdentity(note.problem, note.problemImageKey),
            note.correctAnswer
        ) === identity
    );
}

function canStoreProblemV01(user, identity) {
    const limit = getPlanRule(user.plan).storageLimit;
    return limit == null || limit === Infinity ||
        isAlreadyStoredProblemV01(user, identity) ||
        getStoredProblemCountV01(user) < limit;
}

function storedProblemLimitMessageV01(user) {
    return `현재 요금제의 문제 저장 한도(${getPlanRule(user.plan).storageLimit}개)에 도달했습니다. ` +
        "기존 정답·오답 문제를 정리하거나 유료 요금제를 이용해 주세요.";
}

function ensureUserShape(user) {
    if (!Array.isArray(user.notes)) {
        user.notes = [];
    }

    user.notes = user.notes.map((note) => ({
        unit: "",

        weakConcept: "",
        weakConceptDetail: "",

        errorType: "",
        errorDetail: "",

        problemType: "",
        difficulty: "",

        reviewCount: 0,
        repeatWrongCount: 1,

        latestReviewResult: "wrong",
        masteryStatus: "learning",

        ...note,

        errorType: normalizeErrorType(note.errorType),
        difficulty: normalizeDifficulty(note.difficulty)
    }));

    if (!Array.isArray(user.solvedNotes)) {
        user.solvedNotes = [];
    }

    user.solvedNotes = user.solvedNotes.map((note) => ({
        unit: "",

        weakConcept: "",
        weakConceptDetail: "",

        errorType: "",
        errorDetail: "",

        problemType: "",
        difficulty: "",

        reviewCount: 0,
        repeatWrongCount: 0,

        latestReviewResult: "correct",
        masteryStatus: "learning",

        ...note,

        errorType: normalizeErrorType(note.errorType),
        difficulty: normalizeDifficulty(note.difficulty)
    }));

    if (!Array.isArray(user.trashNotes)) {
        user.trashNotes = [];
    }

    if (
        !user.analysisCache ||
        typeof user.analysisCache !== "object" ||
        Array.isArray(user.analysisCache)
    ) {
        user.analysisCache = {};
    }

    if (
        !user.similarAnswerMap ||
        typeof user.similarAnswerMap !== "object" ||
        Array.isArray(user.similarAnswerMap)
    ) {
        user.similarAnswerMap = {};
    }

    if (
        !user.advancedAnswerMap ||
        typeof user.advancedAnswerMap !== "object" ||
        Array.isArray(user.advancedAnswerMap)
    ) {
        user.advancedAnswerMap = {};
    }

        // 개인 약점 시스템
    // 서버가 학습 기록을 기반으로 계산해서 채운다.
    if (
        !user.weaknessProfile ||
        typeof user.weaknessProfile !== "object" ||
        Array.isArray(user.weaknessProfile)
    ) {
        user.weaknessProfile = {};
    }

    // =====================================
// 기존 약점 학습 이벤트
// =====================================
//
// 기존 weaknessProfile / 복습 시스템이 사용하는 기록.
// ScorePath 전체 풀이 기록과는 별도로 유지한다.
//
if (!Array.isArray(user.learningEvents)) {
    user.learningEvents = [];
}


// =====================================
// ScorePath - 전체 문제 풀이 기록
// =====================================
//
// 맞힌 문제와 틀린 문제를 모두 저장한다.
//
// 이 데이터는 앞으로
// - 단원별 정답률
// - 최근 정답률
// - 문제 난이도별 성취도
// - 반복 오답
// - 학습 추세
// - 데이터 신뢰도
//
// 등을 계산하는 ScorePath 엔진의
// 기본 데이터가 된다.
//
// 기존 사용자의 과거 오답을 억지로 변환하지 않고
// 이 기능 추가 이후의 실제 풀이부터 기록한다.
//
if (!Array.isArray(user.problemHistory)) {
    user.problemHistory = [];
}

    // ================================
// 6단계 - 약점 훈련 시도 기록
// ================================

if (
    !user.weaknessTrainingAttempts ||
    typeof user.weaknessTrainingAttempts !== "object" ||
    Array.isArray(user.weaknessTrainingAttempts)
) {
    user.weaknessTrainingAttempts = {};
}


// ================================
// 7단계 - ScorePath 시험 모드
// ================================

// 사용자가 등록한 시험 일정
//
// examPlans = {
//     [examId]: {
//         id,
//         name,
//         subject,
//         examDate,
//
//         targetScore,
//         dailyStudyMinutes,
//         examRange,
//
//         createdAt,
//         updatedAt
//     }
// }

if (
    !user.examPlans ||
    typeof user.examPlans !== "object" ||
    Array.isArray(user.examPlans)
) {
    user.examPlans = {};
}


// =====================================
// 기존 시험 데이터 → ScorePath 형식 보정
// =====================================

for (const exam of Object.values(user.examPlans)) {

    if (
        !exam ||
        typeof exam !== "object"
    ) {
        continue;
    }


    // 목표 점수
    if (
        exam.targetScore === undefined ||
        exam.targetScore === null ||
        !Number.isFinite(
            Number(exam.targetScore)
        )
    ) {
        exam.targetScore = null;
    } else {
        exam.targetScore =
            Number(exam.targetScore);
    }


    // 하루 공부 가능 시간
    if (
        exam.dailyStudyMinutes === undefined ||
        exam.dailyStudyMinutes === null ||
        !Number.isFinite(
            Number(exam.dailyStudyMinutes)
        )
    ) {
        exam.dailyStudyMinutes = null;
    } else {
        exam.dailyStudyMinutes =
            Number(exam.dailyStudyMinutes);
    }


    // 시험 범위
    if (!Array.isArray(exam.examRange)) {
        exam.examRange = [];
    }

    exam.examRange =
        exam.examRange
            .map((item) => safeText(item))
            .filter(Boolean);
}


// ================================
// 7-4 ScorePath 시험범위 진단 기록
// ================================
//
// examDiagnosisAttempts = {
//     [attemptId]: {
//         id,
//         examId,
//         examName,
//         subject,
//         rangeName,
//
//         status,
//
//         problems,
//         answers,
//
//         currentIndex,
//         correctCount,
//         wrongCount,
//
//         startedAt,
//         updatedAt,
//         completedAt
//     }
// }

if (
    !user.examDiagnosisAttempts ||
    typeof user.examDiagnosisAttempts !== "object" ||
    Array.isArray(user.examDiagnosisAttempts)
) {
    user.examDiagnosisAttempts = {};
}


// ================================
// 7-5 시험 대비 실제 학습 기록
// ================================
//
// examStudyAttempts = {
//     [attemptId]: {
//         id,
//         examId,
//         subject,
//         status,
//         problems,
//         currentIndex,
//         correctCount,
//         wrongCount,
//         startedAt,
//         completedAt
//     }
// }

if (
    !user.examStudyAttempts ||
    typeof user.examStudyAttempts !== "object" ||
    Array.isArray(user.examStudyAttempts)
) {
    user.examStudyAttempts = {};
}


if (!Array.isArray(user.subjects) || user.subjects.length === 0) {
    user.subjects = [...DEFAULT_SUBJECTS];
}

    if (!user.usageAi || user.usageAi.date !== todayString()) {
        user.usageAi = {
            date: todayString(),
            count: 0
        };
    }

    if (
        !user.usageAdvanced ||
        user.usageAdvanced.date !== todayString()
    ) {
        user.usageAdvanced = {
            date: todayString(),
            count: 0,
            usedKeys: []
        };
    }

    if (!Array.isArray(user.usageAdvanced.usedKeys)) {
        user.usageAdvanced.usedKeys = [];
    }
}

// ================================
// 개인 약점 시스템
// ================================

function normalizeWeaknessLabel(value) {
    return safeText(value)
        .replace(/\s+/g, " ")
        .trim();
}

function getWeaknessKey(note) {
    const subject =
        normalizeWeaknessLabel(note?.subject) ||
        "기타";

    const unit =
        normalizeWeaknessLabel(note?.unit) ||
        "기타 단원";

    const weakConcept =
        normalizeWeaknessLabel(note?.weakConcept);

    const weakConceptDetail =
        normalizeWeaknessLabel(note?.weakConceptDetail);

    const problemType =
        normalizeWeaknessLabel(note?.problemType);

    const errorType =
        normalizeWeaknessLabel(note?.errorType);

    // 약점 그룹의 핵심 식별자는 단원명이 아니라
    // 실제로 부족한 핵심 개념을 우선한다.
    //
    // AI가 같은 개념을
    // "수와 연산", "덧셈과 뺄셈"처럼
    // 서로 다른 단원명으로 반환하더라도
    // 같은 약점으로 묶일 수 있게 한다.
    const concept =
        weakConcept ||
        weakConceptDetail ||
        problemType ||
        errorType ||
        "분류되지 않은 약점";

    return {
        subject,
        unit,
        concept,
        weakConcept,
        weakConceptDetail,
        problemType,
        errorType,

        // unit은 표시용 정보로 유지하고
        // 약점 식별 키에서는 제외한다.
        key: `${subject}::${concept}`
    };
}

// =====================================
// ScorePath - 전체 문제 풀이 기록
// =====================================
//
// AI를 호출하지 않는다.
// 이미 서버가 판정한 풀이 결과만 DB에 저장한다.
//
// 이 함수 자체는 writeDb()를 호출하지 않는다.
// 기존 API가 마지막에 수행하는 writeDb(req.db)에
// problemHistory도 함께 저장된다.
//
function recordProblemHistory(
    user,
    {
        examId = "",
        subject = "",
        unit = "",
        problem = "",
        problemImageKey = "",
        userAnswer = "",
        correctAnswer = "",
        isCorrect = false,
        difficulty = "",
        problemType = "",
        sourceType = "normal",
        source = "answer_check"
    } = {}
) {
    ensureUserShape(user);

    const solvedAt = now();

    const historyItem = {
    id: randomUUID(),

    examId:
        safeText(examId),

    subject:
        safeText(subject) ||
        "기타",

        unit:
            safeText(unit),

        problem:
            safeText(problem),

        problemImageKey:
            safeText(problemImageKey),

        userAnswer:
            safeText(userAnswer),

        correctAnswer:
            safeText(correctAnswer),

        result:
            isCorrect
                ? "correct"
                : "wrong",

        isCorrect:
            Boolean(isCorrect),

        difficulty:
            normalizeDifficulty(
                difficulty
            ),

        problemType:
            safeText(problemType),

        sourceType:
            safeText(sourceType) ||
            "normal",

        source:
            safeText(source) ||
            "answer_check",

        solvedAt,
        createdAt: solvedAt
    };

    user.problemHistory.push(
        historyItem
    );

    return historyItem;
}

// =====================================
// ScorePath 19-1
// 시험범위별 풀이 기록 집계
// =====================================

function buildScorePathUnitStats(user, exam) {

    ensureUserShape(user);

    const examId = safeText(exam?.id);
    const subject = safeText(exam?.subject);

    const examRange = Array.isArray(exam?.examRange)
        ? exam.examRange
            .map((unit) => safeText(unit))
            .filter(Boolean)
        : [];

    const history = Array.isArray(user.problemHistory)
        ? user.problemHistory
        : [];

    return examRange.map((unit) => {

        const records = history.filter((item) => {

            return (
                safeText(item.examId) === examId &&
                safeText(item.subject) === subject &&
                safeText(item.unit) === unit
            );

        });

        // =====================================
        // ScorePath 21-54
        // 고유 문제 구분 + 난이도 데이터 집계
        // =====================================

        // 전체 풀이 횟수는 기존대로 유지
        const attempts = records.length;

        const correctCount = records.filter(
            (item) => item.isCorrect === true
        ).length;

        const wrongCount = attempts - correctCount;

        const accuracy = attempts > 0
            ? Math.round(
                (correctCount / attempts) * 1000
            ) / 10
            : null;

        // 동일한 문제의 반복 풀이 구분
        const uniqueProblemMap = new Map();

        records.forEach((item, index) => {

            const imageKey =
                safeText(item.problemImageKey);

            const problemText =
                safeText(item.problem)
                    .replace(/\s+/g, " ")
                    .toLowerCase();

            // 이미지가 있다면 이미지 키 우선
            const problemKey = imageKey
                ? `image:${imageKey}`
                : problemText
                    ? `text:${problemText}`
                    : `record:${item.id || index}`;

            const existing =
                uniqueProblemMap.get(problemKey);

            const itemTime =
                Number(
                    item.solvedAt ||
                    item.createdAt ||
                    0
                );

            const existingTime =
                Number(
                    existing?.solvedAt ||
                    existing?.createdAt ||
                    0
                );

              // =====================================
            // ScorePath 21-231
            // 고유 문제의 첫 풀이 결과 사용
            // =====================================

            // 숙련도 추정에는 같은 문제의
            // 최초 풀이 결과만 반영한다.
            //
            // 같은 문제를 반복해서 맞힌 것은
            // 새로운 문제를 해결할 수 있다는
            // 직접적인 근거가 아니다.

            if (
                !existing ||
                itemTime < existingTime
            ) {
                uniqueProblemMap.set(
                    problemKey,
                    item
                );
            }
        });

        const uniqueRecords =
            [...uniqueProblemMap.values()];

        const uniqueAttempts =
            uniqueRecords.length;

        const uniqueCorrectCount =
            uniqueRecords.filter(
                (item) => item.isCorrect === true
            ).length;

        // 난이도 기록 확인
        const difficultyLevels =
            ["쉬움", "보통", "어려움"];

        // =====================================
        // ScorePath 21-237
        // 난이도 데이터 유효성 검사
        // =====================================

        // 유효한 난이도:
        // 쉬움 / 보통 / 어려움
        //
        // 정답 여부는 반드시
        // true 또는 false여야 한다.
        //
        // 잘못된 데이터는 난이도 통계에서 제외하며
        // 기존 DB 기록은 수정하지 않는다.

        const knownDifficultyRecords =
            uniqueRecords.filter((item) => {

                const validDifficulty =
                    difficultyLevels.includes(
                        safeText(item.difficulty)
                    );

                const validResult =
                    typeof item.isCorrect === "boolean";

                return (
                    validDifficulty &&
                    validResult
                );
            });

        const difficultyMeasuredCount =
            knownDifficultyRecords.length;

        const difficultyLevelCount =
            new Set(
                knownDifficultyRecords.map(
                    (item) => item.difficulty
                )
            ).size;

        return {
            unit,

            // 기존 통계
            attempts,
            correctCount,
            wrongCount,
            accuracy,
            hasData: attempts > 0,

            // 새로운 통계
            uniqueAttempts,
            uniqueCorrectCount,

            repeatedAttempts:
                attempts - uniqueAttempts,

                        difficultyMeasuredCount,
            difficultyLevelCount,

            // =====================================
            // ScorePath 21-78
            // 난이도별 고유 문제 통계
            // =====================================

            difficultyStats: Object.fromEntries(
                difficultyLevels.map((level) => {

                    const levelRecords =
                        knownDifficultyRecords.filter(
                            (item) =>
                                safeText(item.difficulty) === level
                        );

                    const levelCorrect =
                        levelRecords.filter(
                            (item) =>
                                item.isCorrect === true
                        ).length;

                    return [
                        level,
                        {
                            attempts:
                                levelRecords.length,

                            correctCount:
                                levelCorrect,

                            accuracy:
                                levelRecords.length > 0
                                    ? Math.round(
                                        (
                                            levelCorrect /
                                            levelRecords.length
                                        ) * 100
                                    )
                                    : null
                        }
                    ];
                })
            ),

            difficultyUnknownCount:
                Math.max(
                    0,
                    uniqueAttempts - difficultyMeasuredCount
                )
        };

    });

}
// =====================================
// ScorePath - 과거 학습 기록 통합
// =====================================

function getScorePathPastEvidenceV01(user, exam, unit) {

    const subject = safeText(exam?.subject);
    const examId = safeText(exam?.id);
    const cleanUnit = safeText(unit);

    const cutoff = Date.now() - 365 * 86400000;

    const history = Array.isArray(user?.problemHistory)
        ? user.problemHistory
        : [];

    const notes = Array.isArray(user?.notes)
        ? user.notes
        : [];

    const matches = (item) =>
        safeText(item?.subject) === subject &&
        safeText(item?.unit) === cleanUnit;

    const keyOf = (item) => {

        const photo = safeText(item?.problemImageKey);

        const text = safeText(item?.problem)
            .replace(/\s+/g, " ")
            .toLowerCase();

        return photo
            ? `photo:${photo}`
            : text
                ? `text:${text}`
                : "";
    };

    // 이번 시험에서 이미 푼 문제는 중복 제외
    const currentKeys = new Set(
        history
            .filter((item) =>
                matches(item) &&
                safeText(item.examId) === examId
            )
            .map(keyOf)
            .filter(Boolean)
    );

    const previous = new Map();

    // 다른 시험에서 풀었던 관련 문제
    for (const item of history) {

        const time = Number(
            item.solvedAt || item.createdAt || 0
        );

        if (
            !matches(item) ||
            safeText(item.examId) === examId ||
            time < cutoff ||
            time > Date.now()
        ) continue;

        const key = keyOf(item);

        if (!key || currentKeys.has(key)) continue;

        const old = previous.get(key);

        if (
            !old ||
            time >= Number(
                old.solvedAt || old.createdAt || 0
            )
        ) {
            previous.set(key, item);
        }
    }

    // 기존 오답노트는 과거 약점으로 활용
    const oldWrongKeys = new Set();

    for (const note of notes) {

        const time = Number(
            note.updatedAt || note.createdAt || 0
        );

        if (
            !matches(note) ||
            time < cutoff ||
            time > Date.now()
        ) continue;

        const key = keyOf(note);

        if (
            key &&
            !currentKeys.has(key) &&
            !previous.has(key)
        ) {
            oldWrongKeys.add(key);
        }
    }

    const previousWrong = [...previous.values()]
        .filter((item) => item.isCorrect === false)
        .length;

    return {
        historicalUniqueCount: previous.size,
        historicalWrongCount: previousWrong,
        legacyWrongCount: oldWrongKeys.size,

        pastWeaknessCount:
            previousWrong + oldWrongKeys.size
    };
}

// =====================================
// ScorePath 21-1
// 단원별 숙련도 추정 V0.1
// =====================================

function buildScorePathLearningSignalsV01(user, exam) {

    const stats =
        buildScorePathUnitStats(user, exam);

    // =====================================
    // ScorePath 21-55
    // 고유 문제 기반 숙련도 추정 V0.2
    // =====================================

    return stats.map((stat) => {

        const attempts =
            Math.max(
                0,
                Number(stat.attempts) || 0
            );

        const correctCount =
            Math.max(
                0,
                Number(stat.correctCount) || 0
            );

        const uniqueAttempts =
            Math.max(
                0,
                Number(stat.uniqueAttempts) || 0
            );

        const uniqueCorrectCount =
            Math.min(
                uniqueAttempts,
                Math.max(
                    0,
                    Number(stat.uniqueCorrectCount) || 0
                )
            );

        const difficultyMeasuredCount =
            Math.max(
                0,
                Number(stat.difficultyMeasuredCount) || 0
            );

        const difficultyLevelCount =
            Math.max(
                0,
                Number(stat.difficultyLevelCount) || 0
            );

        // 고유 문제 최소 5개 확보 전에는
        // 숫자 숙련도를 표시하지 않는다.
        const needsMoreEvidence =
            uniqueAttempts < 5;

        // 동일 문제 반복 풀이로
        // 숙련도가 과대평가되는 문제 완화
        const estimatedMastery =
            needsMoreEvidence
                ? null
                : Math.round(
                    (
                        (uniqueCorrectCount + 2) /
                        (uniqueAttempts + 4)
                    ) * 100
                );

        // 난이도 분포가 충분히 다양한지
        const hasDifficultyCoverage =
            difficultyLevelCount >= 2 &&
            difficultyMeasuredCount >=
                Math.ceil(uniqueAttempts * 0.6);

        // 데이터 충분성 구분
        // 통계적으로 검증된 신뢰구간은 아님
        let evidenceLevel = "제한적";

        if (
            uniqueAttempts >= 30 &&
            difficultyLevelCount >= 3 &&
            hasDifficultyCoverage
        ) {
            evidenceLevel = "넓음";

        } else if (
            uniqueAttempts >= 12 &&
            hasDifficultyCoverage
        ) {
            evidenceLevel = "보통";
        }

                // =====================================
        // ScorePath 21-57
        // 풀이 근거를 반영한 학습 단계 결정
        // =====================================

        // 숙련도가 높더라도 문제 수와
        // 난이도 다양성이 부족하면
        // 복습 단계로 성급하게 전환하지 않는다.

        const canRecommendReview =
            !needsMoreEvidence &&
            estimatedMastery >= 80 &&
            (
                evidenceLevel === "보통" ||
                evidenceLevel === "넓음"
            );

        let nextAction = "collect";

        if (!needsMoreEvidence) {

            nextAction = canRecommendReview
                ? "review"
                : "practice";
        }

        // =====================================
        // ScorePath 21-165
        // 학습 기록의 출처 구분
        // =====================================

        const pastEvidence =
            getScorePathPastEvidenceV01(
                user,
                exam,
                stat.unit
            );

        const evidenceSource =
            uniqueAttempts >= 5
                ? "current_measured"

                : uniqueAttempts > 0
                    ? "current_partial"

                    : pastEvidence.historicalUniqueCount > 0
                        ? "past_history"

                        : pastEvidence.legacyWrongCount > 0
                            ? "past_wrong_note"

                            : "no_records";

        // =====================================
        // ScorePath 21-207
        // 실력 확인 진행 단계
        // =====================================

        const verificationStage =
            uniqueAttempts === 0
                ? "unmeasured"

                : uniqueAttempts < 5
                    ? "initial"

                    : !hasDifficultyCoverage
                        ? "difficulty_gap"

                        : evidenceLevel === "제한적"
                            ? "provisional"

                            : "supported";

        // 최초 숙련도 참고치 계산까지
        // 추가로 필요한 고유 문제 수
         const additionalUniqueForInitial =
            Math.max(
                0,
                5 - uniqueAttempts
            );

        // =====================================
        // ScorePath 21-213
        // 초기 기록으로 학습 방향 결정
        // =====================================

        const uniqueWrongCount =
            Math.max(
                0,
                uniqueAttempts - uniqueCorrectCount
            );

        // 초기 방향은 확정된 숙련도가 아니다.
        const earlyDirection =
            uniqueAttempts >= 2 &&
            uniqueWrongCount >= 2

                ? "study_concept"

                : uniqueAttempts >= 3 &&
                  uniqueWrongCount === 0

                    ? "practice_new"

                    : "verify_lightly";

        return {
            unit: stat.unit,

            pastEvidence,
            evidenceSource,

            verificationStage,
            additionalUniqueForInitial,

            earlyDirection,
            uniqueWrongCount,

            // =====================================
            // ScorePath 21-228
            // 난이도별 학습 격차 감지
            // =====================================

             // =====================================
            // ScorePath 21-238
            // 난이도별 취약점 판단 신뢰성 강화
            // =====================================

            // 조건:
            // 1. 고유 문제 7개 이상
            // 2. 난이도 기록률 80% 이상
            // 3. 쉬운 문제 4개 이상
            // 4. 어려운 문제 3개 이상
            // 5. 쉬운 문제 정답률 75% 이상
            // 6. 어려운 문제 정답률 50% 이하
            //
            // 위 기준은 초기 실험용이다.

            challengingDifficultyGap:

                uniqueAttempts >= 7 &&

                difficultyMeasuredCount >=
                    Math.ceil(
                        uniqueAttempts * 0.8
                    ) &&

                Number(
                    stat.difficultyStats?.["쉬움"]
                        ?.attempts || 0
                ) >= 4 &&

                stat.difficultyStats?.["쉬움"]
                    ?.accuracy != null &&

                Number(
                    stat.difficultyStats["쉬움"]
                        .accuracy
                ) >= 75 &&

                Number(
                    stat.difficultyStats?.["어려움"]
                        ?.attempts || 0
                ) >= 3 &&

                stat.difficultyStats?.["어려움"]
                    ?.accuracy != null &&

                Number(
                    stat.difficultyStats["어려움"]
                        .accuracy
                ) <= 50,

            attempts,
            correctCount,

            uniqueAttempts,
            uniqueCorrectCount,

            difficultyMeasuredCount,
            difficultyLevelCount,

            needsMoreEvidence,
            estimatedMastery,

            evidenceLevel,
            hasDifficultyCoverage,

            nextAction
        };

    });
}

// =====================================
// ScorePath 21-5
// 학습 우선순위 엔진 V0.1
// =====================================

// =====================================
// ScorePath 21-16
// D-day 기반 학습 우선순위 V0.2
// =====================================

function buildScorePathStudyPriorityV01(user, exam) {

    const signals =
        buildScorePathLearningSignalsV01(user, exam);

    // 실제 선택된 시험에서 틀린 문제만 AI 약점과 연결한다.
    // 시험 밖의 오답과 AI 미분류 결과는 추천에 사용하지 않는다.
    const examWrongProblemKeys = new Set(
        (Array.isArray(user.problemHistory)
            ? user.problemHistory : []
        )
            .filter((item) =>
                safeText(item.examId) === safeText(exam?.id) &&
                safeText(item.subject) === safeText(exam?.subject) &&
                item.isCorrect === false
            )
            .map((item) => getProblemIdentity(
                item.problem,
                item.problemImageKey
            ))
            .filter(Boolean)
    );

    const aiWeakConceptsByUnit = new Map();

    for (const note of (Array.isArray(user.notes) ? user.notes : [])) {
        const unit = safeText(note.unit);
        const concept = safeText(note.weakConcept);
        const problemKey = getProblemIdentity(
            note.problem,
            note.problemImageKey
        );

        if (
            safeText(note.subject) !== safeText(exam?.subject) ||
            !unit || !concept ||
            !examWrongProblemKeys.has(problemKey) ||
            !signals.some((signal) => safeText(signal.unit) === unit)
        ) continue;

        if (!aiWeakConceptsByUnit.has(unit)) {
            aiWeakConceptsByUnit.set(unit, new Set());
        }

        aiWeakConceptsByUnit.get(unit).add(concept);
    }

    // =====================================
    // ScorePath 21-204
    // 신규 학생의 학습 근거 확인
    // =====================================

    const isColdStart =
        signals.length > 0 &&
        signals.every((item) =>
            Number(item.uniqueAttempts || 0) === 0 &&
            Number(
                item.pastEvidence?.historicalUniqueCount || 0
            ) === 0 &&
            Number(
                item.pastEvidence?.legacyWrongCount || 0
            ) === 0
        );

     // =====================================
    // ScorePath 21-38
    // 날짜 기준 D-day 계산
    // =====================================

    const examDateText =
        String(exam?.examDate || "");

    const examTime = /^\d{4}-\d{2}-\d{2}$/.test(examDateText)
        ? new Date(`${examDateText}T00:00:00`).getTime()
        : NaN;

    const today = new Date();

    today.setHours(0, 0, 0, 0);

    const todayTime =
        today.getTime();

    const daysLeft =
        Number.isFinite(examTime)
            ? Math.round(
                (examTime - todayTime) / 86400000
            )
            : null;

    // 시험 7일 이내
    const isUrgent =
        daysLeft !== null &&
        daysLeft >= 0 &&
        daysLeft <= 7;

    // =====================================
    // ScorePath 21-216
    // 시험범위 순서와 선행 관계
    // =====================================

    const examUnits =
        signals.map((item) =>
            safeText(item.unit)
        );

    const unitOrder = new Map(
        examUnits.map((unit, index) => [
            unit,
            index
        ])
    );

    // 명시적으로 저장된 선행 관계만 사용
    // 예: { "도함수": ["미분계수"] }

    const rawPrerequisites =
        exam?.unitPrerequisites &&
        typeof exam.unitPrerequisites === "object" &&
        !Array.isArray(exam.unitPrerequisites)

            ? exam.unitPrerequisites
            : {};

    // 각 단원이 다른 몇 개 단원의
    // 선행 개념인지 계산

    const dependentCounts = new Map(
        examUnits.map((unit) => [
            unit,
            0
        ])
    );

    for (
        const [unit, prerequisites]
        of Object.entries(rawPrerequisites)
    ) {

        if (
            !unitOrder.has(unit) ||
            !Array.isArray(prerequisites)
        ) continue;

        for (
            const parent
            of new Set(prerequisites.map(safeText))
        ) {

            if (
                !unitOrder.has(parent) ||
                parent === unit
            ) continue;

            dependentCounts.set(
                parent,
                dependentCounts.get(parent) + 1
            );
        }
    }

    // =====================================
    // ScorePath 21-222
    // 별도 설정 없는 시험도 첫 추천 가능
    // =====================================

    // 중요도를 따로 설정했는지 확인
    const hasCustomImportance =
        examUnits.some((unit) => {

            const value =
                Number(
                    exam?.unitImportance?.[unit] ?? 3
                );

            return (
                Number.isInteger(value) &&
                value >= 1 &&
                value <= 5 &&
                value !== 3
            );
        });

    // 명시적 선행 관계가 있는지 확인
    const hasPrerequisiteSettings =
        [...dependentCounts.values()].some(
            (count) => count > 0
        );

    // 둘 다 설정하지 않았다면
    // 기본 중요도와 시험범위 입력 순서 사용
    const usesDefaultFirstOrder =
        !hasCustomImportance &&
        !hasPrerequisiteSettings;

    return signals
        .map((signal) => {

            const mastery =
                signal.estimatedMastery;

            let priorityScore = 0;
            let reason = "";

            // =====================================
            // ScorePath 21-319
            // 시험일에 따른 점진적 우선순위 반영
            // =====================================

            const knownMastery =
                typeof mastery === "number" &&
                Number.isFinite(mastery)

                    ? Math.max(
                        0,
                        Math.min(100, mastery)
                    )

                    : null;

            const isPractice =
                signal.nextAction === "practice" &&
                knownMastery !== null;

            const needsEvidence =
                knownMastery === null ||
                signal.needsMoreEvidence === true;

            const attempts =
                Math.max(
                    0,
                    Number(signal.attempts) || 0
                );

            // =====================================
            // 1. 시험 여유 시 기본 우선순위
            // =====================================

            const normalPriority = isPractice

                ? 760 + Math.max(
                    0,
                    80 - knownMastery
                )

                : needsEvidence

                    ? 650 - Math.min(
                        attempts,
                        4
                    ) * 10

                    : 100 + (
                        100 - knownMastery
                    );

            // =====================================
            // 2. 시험 임박 시 기본 우선순위
            // =====================================

            const urgentPriority = isPractice

                ? 900 + (
                    100 - knownMastery
                )

                : needsEvidence

                    ? 700 - Math.min(
                        attempts,
                        4
                    ) * 10

                    : 100 + (
                        100 - knownMastery
                    );

            // =====================================
            // 3. 시험 임박 정도 계산
            // =====================================

            // D-8부터 D-day까지
            // 우선순위를 점진적으로 변경한다.
            //
            // 기존 D-7 및 D-3에서 발생하던
            // 갑작스러운 점수 변경을 완화한다.

            const urgencyProgress =
                daysLeft === null ||
                daysLeft < 0

                    ? 0

                    : Math.max(
                        0,
                        Math.min(
                            1,
                            (8 - daysLeft) / 8
                        )
                    );

            // =====================================
            // 4. 학습 우선순위 계산
            // =====================================

            priorityScore = Math.round(

                normalPriority +

                (
                    urgentPriority -
                    normalPriority
                ) * urgencyProgress

            );

            // =====================================
            // 5. 취약 단원 집중도 반영
            // =====================================

            if (isPractice) {

                priorityScore +=
                    Math.round(
                        150 * urgencyProgress
                    );
            }

            // =====================================
            // 6. 추천 이유
            // =====================================

            reason = isPractice

                ? "확인된 취약 단원 보완"

                : needsEvidence

                    ? "기록 부족 · 현재 실력 확인"

                    : "실력 유지 및 복습";

            if (urgencyProgress > 0) {

                reason +=
                    ` · 시험까지 ${daysLeft}일 남음`;
            }

            // =====================================
            // ScorePath 21-17
            // 최근 풀이 횟수에 따른 우선순위 조절
            // =====================================

            const recentWindowStart =
                Date.now() - 24 * 60 * 60 * 1000;

            const history =
                Array.isArray(user?.problemHistory)
                    ? user.problemHistory
                    : [];

            // =====================================
            // ScorePath 21-311
            // 최근 공부량의 고유 문제 기준 집계
            // =====================================

            // 같은 문제를 반복해서 풀었다는 이유로
            // 서로 다른 문제를 여러 개 공부한 것처럼
            // 계산하지 않는다.

            const recentProblemKeys = new Set();

            for (const item of history) {

                if (
                    safeText(item.examId) !== safeText(exam?.id) ||
                    safeText(item.subject) !== safeText(exam?.subject) ||
                    safeText(item.unit) !== safeText(signal.unit) ||
                    Number(item.solvedAt || item.createdAt || 0) < recentWindowStart
                ) {
                    continue;
                }

                // =====================================
                // 문제 식별
                // =====================================

                const imageKey =
                    safeText(item.problemImageKey);

                const problemText =
                    safeText(item.problem)
                        .replace(/\s+/g, " ")
                        .toLowerCase();

                const key = imageKey

                    ? `image:${imageKey}`

                    : problemText
                        ? `text:${problemText}`
                        : "";

                if (key) {
                    recentProblemKeys.add(key);
                }
            }

            // 최근 24시간에 푼 서로 다른 문제 수
            const recentAttempts =
                recentProblemKeys.size;

            // =====================================
            // ScorePath 21-313
            // 최근 풀이 횟수만으로 우선순위 감점 금지
            // =====================================

            // 최근에 문제를 많이 풀었다는 사실만으로
            // 해당 단원을 충분히 학습했다고 판단하지 않는다.
            //
            // 정답 여부와 학습 후 검증 결과는
            // 아래의 별도 규칙에서 판단한다.

            if (recentAttempts > 0) {

                reason +=
                    " · 최근 문제풀이 기록 있음";
            }

            // =====================================
            // ScorePath 21-223
            // 초기 오답을 추천 순위에 반영
            // =====================================

            // 신규 학생의 첫 추천에는 적용하지 않음
            // 고유 문제 2~4개에서 반복 오답이
            // 나타난 경우에만 임시 보정

            if (
                !isColdStart &&
                signal.verificationStage === "initial" &&
                signal.earlyDirection === "study_concept"
            ) {

                // 초기 오답 단원에 우선순위 부여
                // 실제 성적 상승 효과로 검증된 값은 아님
                priorityScore += 140;

                reason +=
                    " · 초기 오답 반복(잠정 개념 학습)";
            }

            // =====================================
            // ScorePath 21-166
            // 과거 오답 우선순위 보정
            // =====================================

            const pastWeaknessCount =
                Math.max(
                    0,
                    Number(
                        signal.pastEvidence
                            ?.pastWeaknessCount
                    ) || 0
                );

            // 현재 실력이 불확실할 때만
            // 과거 오답을 참고한다.
            const pastWeaknessBonus =
                signal.needsMoreEvidence &&
                pastWeaknessCount > 0

                    ? Math.min(
                        45,
                        15 +
                        Math.min(
                            pastWeaknessCount,
                            3
                        ) * 10
                    )

                    : 0;

            priorityScore += pastWeaknessBonus;

            if (pastWeaknessBonus > 0) {

                reason +=
                    " · 과거 오답 참고(현재 실력 확인 필요)";
            }

            // AI가 분석한 확인 필요 개념은 보조 근거로만 사용.
            // 실제 풀이로 연결된 오답만 포함하며, 숙련도는 변경하지 않는다.
            const aiConcepts =
                aiWeakConceptsByUnit.get(safeText(signal.unit));

            if (aiConcepts?.size > 0) {

                // AI 추정치의 영향은 작게 제한한다.
                priorityScore += Math.min(24, aiConcepts.size * 8);

                reason +=
                    " · AI 추정 확인 개념: " +
                    [...aiConcepts].slice(0, 2).join(", ") +
                    "(추가 확인 필요)";
            }

            // =====================================
            // ScorePath 21-71
            // 최근 학습 결과를 추천에 반영
            // =====================================

            // 최근 48시간 안의 완료된 학습
            const recentCompleted = (
                Array.isArray(
                    user.scorePathStudySessions
                )
                    ? user.scorePathStudySessions
                    : []
            )
                .filter((item) => {

                    return (
                        item.examId ===
                            safeText(exam?.id) &&

                        item.unit ===
                            signal.unit &&

                        item.status ===
                            "completed" &&

                        Number(
                            item.completedAt || 0
                        ) >=
                            Date.now() -
                            48 * 60 * 60 * 1000
                    );
                })
                .sort(
                    (a, b) =>
                        Number(b.completedAt || 0) -
                        Number(a.completedAt || 0)
                )[0];

            const recentResults =
                recentCompleted?.results;

            const newUnique =
                Number(
                    recentResults?.newUniqueAttempts
                );

            // =====================================
            // ScorePath 21-233
            // 새로운 문제의 첫 정답률로 재추천
            // =====================================

            // 전체 풀이 정답률에는
            // 같은 문제의 재풀이가 포함된다.
            //
            // 따라서 새로운 고유 문제의
            // 첫 풀이 정답률을 사용한다.

            const recentAccuracy =
                recentResults
                    ?.shortVerification
                    ?.accuracy == null

                    ? null

                    : Number(
                        recentResults
                            .shortVerification
                            .accuracy
                    );

             // =====================================
            // ScorePath 21-252
            // 학습 후 3문제 검증과 재추천 기준 일치
            // =====================================

            const verifiedProblemCount =
                Number(
                    recentResults?.shortVerification?.newProblems
                );

            const validRecentCheck =
                Number.isInteger(newUnique) &&
                newUnique >= 3 &&
                Number.isInteger(verifiedProblemCount) &&
                verifiedProblemCount === newUnique &&
                recentAccuracy !== null &&
                Number.isFinite(recentAccuracy) &&
                recentAccuracy >= 0 &&
                recentAccuracy <= 100;

            if (validRecentCheck) {

                // 3~4문제는 작은 표본이므로 약하게 반영
                const limitedSample = newUnique < 5;

                if (recentAccuracy < 60) {

                    priorityScore += limitedSample ? 45 : 80;

                    reason += limitedSample
                        ? " · 새 문제에서 오답 다수(잠정 근거)"
                        : " · 최근 새 문제 정답률 낮음";

                } else if (recentAccuracy >= 85) {

                    priorityScore -= limitedSample ? 15 : 30;

                    reason += limitedSample
                        ? " · 새 문제 정답률 높음(잠정 근거)"
                        : " · 최근 새 문제 정답률 높음";
                }
            }

            // =====================================
            // ScorePath 21-236
            // 최근 새 문제의 난이도별 성과 반영
            // =====================================

            const recentDifficulty =
                recentResults
                    ?.shortVerification
                    ?.difficultyStats;

            const easyRecent =
                recentDifficulty?.["쉬움"];

            const hardRecent =
                recentDifficulty?.["어려움"];

            const easyRecentAttempts =
                Number(easyRecent?.attempts) || 0;

            const hardRecentAttempts =
                Number(hardRecent?.attempts) || 0;

            const easyRecentAccuracy =
                easyRecent?.accuracy == null

                    ? null

                    : Number(easyRecent.accuracy);

            const hardRecentAccuracy =
                hardRecent?.accuracy == null

                    ? null

                    : Number(hardRecent.accuracy);

            // =====================================
            // 최소한의 풀이 근거 확인
            // =====================================

            // 전체 새 문제 5개 이상
            // 어려운 새 문제 3개 이상
            //
            // 초기 실험 기준이며
            // 통계적으로 검증된 기준은 아님.

            // =====================================
            // ScorePath 21-239
            // 최근 학습 난이도 데이터 신뢰성 확인
            // =====================================

            // 보통 난이도 문제 수
            const mediumRecentAttempts =
                Number(
                    recentDifficulty?.["보통"]
                        ?.attempts ?? 0
                );

            // 난이도별 문제 수
            const difficultyCounts = [
                easyRecentAttempts,
                mediumRecentAttempts,
                hardRecentAttempts
            ];

            // 난이도가 기록된 문제 총합
            const knownRecentAttempts =
                difficultyCounts.reduce(
                    (sum, count) =>
                        sum + count,
                    0
                );

            // =====================================
            // 난이도 데이터 검증
            // =====================================

            const reliableRecentDifficulty =

                // 새로운 고유 문제 5개 이상
                Number.isInteger(newUnique) &&
                newUnique >= 5 &&

                // 문제 수가 정상적인 정수인지
                difficultyCounts.every(
                    (count) =>
                        Number.isInteger(count) &&
                        count >= 0
                ) &&

                // 난이도별 문제 수의 합계 검증
                knownRecentAttempts <= newUnique &&

                // 난이도 기록률 80% 이상
                knownRecentAttempts >=
                    Math.ceil(newUnique * 0.8) &&

                // 어려운 새 문제 3개 이상
                hardRecentAttempts >= 3 &&

                // 어려운 문제 정답률 유효성
                hardRecentAccuracy !== null &&
                Number.isFinite(hardRecentAccuracy) &&
                hardRecentAccuracy >= 0 &&
                hardRecentAccuracy <= 100 &&

                // 쉬운 문제 정답률 유효성
                (
                    easyRecentAccuracy === null ||

                    (
                        Number.isFinite(
                            easyRecentAccuracy
                        ) &&

                        easyRecentAccuracy >= 0 &&
                        easyRecentAccuracy <= 100
                    )
                );

            // 검증을 통과한 경우에만
            // 기존 난이도별 추천 점수 보정 실행

            if (reliableRecentDifficulty) {

                // =====================================
                // 1. 쉬운 문제는 잘 풀지만
                // 어려운 문제에서 오답이 반복된 경우
                // =====================================

                if (
                    easyRecentAttempts >= 3 &&

                    easyRecentAccuracy !== null &&

                    easyRecentAccuracy >= 75 &&

                    hardRecentAccuracy <= 50
                ) {

                    priorityScore += 35;

                    reason +=
                        " · 최근 새 어려운 문제 보완 필요";
                }

                // =====================================
                // 2. 어려운 새 문제에서
                // 높은 정답률을 기록한 경우
                // =====================================

                else if (
                    hardRecentAttempts >= 5 &&
                    hardRecentAccuracy >= 80
                ) {

                    priorityScore -= 20;

                    reason +=
                        " · 최근 새 어려운 문제 정답률 높음";
                }
            }

            // =====================================
            // ScorePath 21-21
            // 단원별 시험 중요도 반영
            // =====================================

            const importanceValue =
                Number(
                    exam?.unitImportance?.[signal.unit] ?? 3
                );

            // 중요도 1~5 검증
            const unitImportance =
                Number.isInteger(importanceValue) &&
                importanceValue >= 1 &&
                importanceValue <= 5
                    ? importanceValue
                    : 3;

            // =====================================
            // ScorePath 21-21
            // 시험 중요도 반영
            // =====================================

            const importanceBonus =
                (unitImportance - 3) * 40;

            priorityScore += importanceBonus;

            reason +=
                ` · 시험 중요도 ${unitImportance}/5`;


            // =====================================
            // ScorePath 21-314
            // 시험 점수와 개념 숙련도 구분
            // =====================================

            // 시험 목표 점수와 개념별 추정 숙련도는
            // 서로 다른 지표다.
            //
            // 예:
            // 목표 시험 점수 80점
            // 미분계수 추정 숙련도 40%
            //
            // 두 값의 차이인 40을
            // 실제 성적 부족분으로 취급하지 않는다.

            // 기존 목표 점수 보너스는 최종 계산에서
            // 다시 차감되고 있었으므로 제거한다.

            // 시험일까지 남은 기간은 이미
            // daysLeft와 isUrgent로 반영되고 있다.

            // 목표 점수는 추후 실제 시험 성적과
            // 비교해 시험 전체 계획에서 활용한다.

            // =====================================
            // ScorePath 21-79
            // 난이도별 풀이 근거 부족 보정
            // =====================================

            const difficultyEvidenceGap =
                Number(signal.uniqueAttempts) >= 5 &&
                signal.hasDifficultyCoverage !== true;

            if (difficultyEvidenceGap) {

                // 난이도 정보나 다양성이 부족하면
                // 추가 확인의 우선순위를 소폭 높인다.
                //
                // +25점은 임시 규칙이며
                // 실제 성적 향상 효과로 검증되지 않았다.

                priorityScore += 25;

                reason +=
                    " · 문제 난이도별 확인 필요";
            }

             // =====================================
            // =====================================
            // ScorePath 21-230
            // 난이도별 학습 격차 반영
            // =====================================

            // 가중치 60은 실험용이며
            // 실제 성적 향상 효과는 검증되지 않음

            if (
                signal.challengingDifficultyGap === true
            ) {

                priorityScore += 60;

                reason +=
                    " · 어려운 문제 오답 집중";
            }

            // ScorePath 21-170
            // 시간 대비 학습 가치 추정 V0.1
            // =====================================

            // 실제 시험 점수 상승 예측값은 아니다.

            const pastWeakness =
                Number(
                    signal.pastEvidence?.pastWeaknessCount || 0
                ) > 0;

            // =====================================
            // 1. 활동별 임시 소요시간
            // =====================================

            const estimatedMinutes =
                signal.needsMoreEvidence
                    ? (pastWeakness ? 10 : 15)
                    : signal.nextAction === "review"
                        ? 10
                        : mastery < 60 ? 25 : 20;

            // =====================================
            // 2. 학습 활동의 상대적 가치
            // =====================================

            const actionValue =
                signal.needsMoreEvidence
                    ? (pastWeakness ? 0.7 : 0.45)
                    : signal.nextAction === "review"
                        ? 0.35
                        : mastery < 60 ? 1.6
                        : mastery < 80 ? 1.1 : 0.7;

              // =====================================
            // ScorePath 21-320
            // 시간 대비 학습 가치의 중복 가중치 제거
            // =====================================

            // 시험 중요도는 이미
            // importanceBonus에 반영된다.
            //
            // 같은 중요도를 시간 효율 계산에
            // 다시 곱하지 않는다.
            //
            // 목표 점수 80점 경계에 따른
            // 임의의 추가 가중치도 제거한다.
            //
            // 실제 성적 상승량을 예측하는
            // 계산식은 아니다.

            const efficiencyScore =
                actionValue /
                estimatedMinutes;

            // =====================================
            // 4. 기존 추천 점수와 결합
            // =====================================

             // =====================================
            // ScorePath 21-315
            // 실제 학습 근거 기반 우선순위 결합
            // =====================================

            // 현재 우선순위 계산에는 다음 정보가 반영된다.
            //
            // 1. 학습 기록과 추정 숙련도
            // 2. 학습 후 검증 결과
            // 3. 시험까지 남은 기간
            // 4. 단원별 시험 중요도
            // 5. 문제 난이도별 학습 근거
            //
            // 시험 목표 점수와 숙련도를 직접 비교한
            // 보너스는 더 이상 사용하지 않는다.

            const priorityWithoutGoalGap =
                Math.max(0, priorityScore);
            // =====================================
            // ScorePath 21-203
            // 학습 결과와 시간 효율 균형 개선
            // =====================================

            // 기존 위험도·시험 임박·학습 결과가
            // 시간 효율 계산에 묻히지 않도록 조정

            // 실제 성적 상승 효과로
            // 검증된 가중치는 아니다.

            // =====================================
            // ScorePath 21-217
            // 신규 학생의 첫 공부 순서
            // =====================================

            // 시험이 3일 이하이거나
            // 하루 공부시간이 20분 이하인 경우

            const shortOnTime =
                (
                    daysLeft !== null &&
                    daysLeft >= 0 &&
                    daysLeft <= 3
                ) ||
                (
                    Number(exam?.dailyStudyMinutes) > 0 &&
                    Number(exam.dailyStudyMinutes) <= 20
                );

            // 해당 단원이 다른 단원의
            // 선행 개념으로 지정된 횟수

            const dependentCount =
                dependentCounts.get(signal.unit) || 0;

            // 시간이 부족하면 선행 관계보다
            // 시험 중요도에 집중

            const prerequisiteBonus =
                Math.min(dependentCount, 3) *
                (shortOnTime ? 5 : 20);

            // 중요도와 선행 관계가 같으면
            // 시험범위 입력 순서를 참고

            const fallbackOrder =
                examUnits.length -
                (
                    unitOrder.get(signal.unit) ??
                    examUnits.length
                );

            // 신규 학생의 임시 우선순위

            const coldStartPriority =
                unitImportance * 100 +
                prerequisiteBonus +
                fallbackOrder / 100;

            // =====================================
            // 기존 학생과 신규 학생 구분
            // =====================================

            // =====================================
            // ScorePath 21-321
            // 학습 필요성 중심 추천
            // =====================================

            // 학습 필요성 및 시험 중요도를
            // 먼저 판단한다.
            //
            // 예상 소요시간은 우선순위가
            // 비슷한 단원의 보조 판단에만 사용한다.
            //
            // 효율 점수는 0 이상 1 미만으로 제한해
            // 기본 우선순위를 뒤집지 않도록 한다.

            const efficiencyTieBreaker =
                efficiencyScore /
                (1 + efficiencyScore);

            const adjustedPriority =
                isColdStart

                    ? coldStartPriority

                    : priorityWithoutGoalGap +
                      efficiencyTieBreaker;

            const cleanReason =
                reason.replace(
                    " · 목표 수준 대비 보완 필요",
                    ""
                );

            return {
                ...signal,

                priorityScore:
                    adjustedPriority,

                // =====================================
                // ScorePath 21-205
                // 신규 학생의 임시 추천 안내
                // =====================================

                // =====================================
                // ScorePath 21-218
                // 첫 공부 추천 이유
                // =====================================

                   // =====================================
                // ScorePath 21-224
                // 첫 추천과 개인화 추천 구분
                // =====================================

                reason: isColdStart

                    ? [

                        "첫 학습 · 개인 실력 미측정",

                        usesDefaultFirstOrder

                            ? "기본 중요도 3/5 · 시험범위 입력 순서 기준"

                            : `시험 중요도 ${unitImportance}/5`,

                        dependentCount > 0

                            ? `다른 ${dependentCount}개 단원의 명시적 선행 개념`

                            : null,

                        shortOnTime

                            ? "시험 또는 오늘 공부시간이 짧아 중요도 우선"

                            : null,

                        "임시 추천(약점 판정 아님)"

                      ]
                      .filter(Boolean)
                      .join(" · ")

                    : [

                        cleanReason,

                        signal.evidenceSource === "no_records"

                            ? "이 단원은 아직 개인 실력 미측정"

                            : signal.verificationStage === "initial"

                                ? "초기 문제 기록 · 숙련도 미확정"

                                : null,

                        "시간 대비 학습 가치(임시 추정)"

                      ]
                      .filter(Boolean)
                      .join(" · "),

                estimatedMinutes,

                efficiencyScore:
                    Math.round(
                        efficiencyScore * 1000
                    ) / 1000,

                recentAttempts,
                unitImportance,
                importanceBonus,

                goalGap: null,
                goalBonus: 0
            };

        })
        .sort(
            (a, b) =>
                b.priorityScore - a.priorityScore
        );
}

// =====================================
// ScorePath 21-63
// 단원별 학습 활동 결정 엔진 V0.1
// =====================================

function buildScorePathStudyActivityV01(
    signal,
    daysLeft = null,
    availableMinutes = null
) {

    const mastery =
        signal?.estimatedMastery;

    // =====================================
    // ScorePath 21-210
    // 배정된 학습시간 확인
    // =====================================

    const sessionMinutes =
        Number.isFinite(Number(availableMinutes)) &&
        Number(availableMinutes) > 0

            ? Number(availableMinutes)

            : null;

    // =====================================
    // ScorePath 21-109
    // 시험 D-day에 따른 학습 활동 변경
    // =====================================

    // 1. 풀이 데이터 부족
    if (
        signal?.needsMoreEvidence === true ||
        !Number.isFinite(mastery)
    ) {

        // =====================================
        // ScorePath 21-211
        // 진단할지 바로 공부할지 판단
        // =====================================

        // 1. 공부시간이 짧은 경우
        if (
            sessionMinutes !== null &&
            sessionMinutes <= 12
        ) {

            return {

                activityType: "concept",

                activityTitle:
                    "짧은 핵심 학습",

                activityGuide:
                    "배정된 시간이 짧으므로 긴 진단 대신 " +
                    "핵심 개념을 보고 대표 문제 1개를 풀어보세요. " +
                    "결과를 기록하면 다음 추천에 반영됩니다."
            };
        }

        // =====================================
        // 2. 기록이 없고 시험까지 여유가 있는 경우
        // =====================================

        if (
            signal?.evidenceSource === "no_records" &&

            Number.isFinite(daysLeft) &&
            daysLeft >= 8 &&

            sessionMinutes !== null &&
            sessionMinutes >= 20
        ) {

            return {

                activityType: "collect",

                activityTitle:
                    "첫 실력 확인 · 2~3문제",

                activityGuide:
                    "처음 보는 교재 문제 2~3개로 시작하세요. " +
                    "결과에 따라 개념 공부 또는 문제 연습으로 이어갑니다. " +
                    "2~3문제만으로 숙련도를 확정하지는 않습니다."
            };
        }

        // =====================================
        // 3. 시험이 가까운데 기록이 없는 경우
        // =====================================

        if (
            signal?.evidenceSource === "no_records" &&

            Number.isFinite(daysLeft) &&
            daysLeft >= 4 &&
            daysLeft <= 7
        ) {

            return {

                activityType: "concept",

                activityTitle:
                    "핵심 개념 공부부터 시작",

                activityGuide:
                    "아직 개인 실력 기록이 없으므로 " +
                    "약점이라고 단정할 수 없어요. " +
                    "핵심 개념을 먼저 공부하고 " +
                    "새 문제 1~2개로 확인하세요."
            };
        }

        // =====================================
        // ScorePath 21-167
        // 과거 기록을 이용한 빠른 실력 확인
        // =====================================

        const past =
            signal?.pastEvidence || {};

        const normalWindow =
            daysLeft === null ||
            daysLeft > 3;

            // =====================================
        // ScorePath 21-214
        // 진단보다 실제 공부가 유리한지 판단
        // =====================================

        if (
            normalWindow &&
            signal?.verificationStage === "initial"
        ) {

            // 1. 오답이 반복된 경우
            // 개념 공부부터 시작
            if (
                signal.earlyDirection === "study_concept"
            ) {

                return {

                    activityType: "concept",

                    activityTitle:
                        "틀린 개념부터 바로 공부",

                    activityGuide:
                        "현재 풀이에서 오답이 반복됐어요. " +
                        "추가 진단만 계속하기보다 " +
                        "틀린 문제와 관련된 개념을 먼저 복습하세요. " +
                        "이후 새로운 문제로 확인하세요."
                };
            }

            // 2. 초기 문제를 모두 맞힌 경우
            // 새로운 유형으로 학습 확장
            if (
                signal.earlyDirection === "practice_new"
            ) {

                return {

                    activityType: "practice",

                    activityTitle:
                        "다른 유형의 문제로 실력 확장",

                    activityGuide:
                        "현재까지 푼 문제는 모두 맞혔어요. " +
                        "같은 유형의 쉬운 문제만 반복하기보다 " +
                        "다른 유형이나 난이도의 문제를 연습하세요. " +
                        "아직 숙련도가 확정된 것은 아닙니다."
                };
            }

            // 3. 방향이 불확실한 경우
            // 짧게 확인
            return {

                activityType: "collect",

                activityTitle:
                    "짧은 추가 확인",

                activityGuide:
                    "현재 기록만으로 공부 방향을 " +
                    "판단하기 어려워요. " +
                    "새로운 유형의 문제 1~2개를 확인하고 " +
                    "틀린 부분부터 공부하세요. " +
                    "정확한 숙련도 측정을 기다릴 필요는 없습니다."
            };
        }

        // 과거 오답이 존재하는 경우
        if (
            normalWindow &&
            Number(
                past.pastWeaknessCount || 0
            ) > 0
        ) {

            return {

                activityType: "concept",

                activityTitle:
                    "과거 오답 복습 + 새 문제 확인",

                activityGuide:
                    "이전에 틀린 개념부터 복습한 뒤, " +
                    "처음 보는 문제 2~3개로 현재 실력을 확인하세요. " +
                    "과거 기록만으로 숙련도를 확정하지 않습니다."
            };
        }

        // 과거 정답·풀이 기록만 존재하는 경우
        if (
            normalWindow &&
            Number(
                past.historicalUniqueCount || 0
            ) > 0
        ) {

            return {

                activityType: "collect",

                activityTitle:
                    "과거 학습 내용 빠른 재확인",

                activityGuide:
                    "전에 공부한 단원이므로 전체 진단부터 시작하지 말고 " +
                    "새로운 문제 2~3개로 현재 실력을 먼저 확인하세요."
            };
        }

        // =====================================
        // 시험까지 3일 이하
        // =====================================

        if (
            Number.isFinite(daysLeft) &&
            daysLeft >= 0 &&
            daysLeft <= 3
        ) {

            return {
                activityType: "collect",

                activityTitle:
                    "시험 직전 핵심 점검",

                activityGuide:
                    "이 단원의 핵심 개념을 빠르게 확인하고 대표 문제로 이해도를 점검하세요. " +
                    "풀이 기록이 적으므로 숙련도를 확정하지 않습니다."
            };
        }

        // =====================================
        // 시험까지 4일 이상
        // =====================================

        // =====================================
        // ScorePath 21-206
        // 신규 학생의 첫 학습 안내
        // =====================================

        if (signal?.evidenceSource === "no_records") {

            return {

                activityType: "collect",

                activityTitle:
                    "첫 학습 · 짧은 기초 확인",

                activityGuide:
                    "교과서나 학교 문제집에서 처음 보는 " +
                    "기본 문제 2~3개를 풀어보세요. " +
                    "막히면 해당 개념을 10분 복습한 뒤 " +
                    "다른 문제로 확인하세요. " +
                    "결과를 기록하면 다음 추천에 반영됩니다."
            };
        }

        return {
            activityType: "collect",

            activityTitle:
                "다양한 문제로 실력 확인",

            activityGuide:
                "서로 다른 유형과 난이도의 문제를 풀어 현재 실력을 확인하세요."
        };
    }

    // =====================================
    // ScorePath 21-229
    // 난이도별 취약점에 맞춘 학습
    // =====================================

    if (
        signal?.challengingDifficultyGap === true
    ) {

        return {

            activityType: "practice",

            activityTitle:
                "어려운 문제 유형 집중 연습",

            activityGuide:
                "쉬운 문제는 비교적 잘 풀었지만 " +
                "어려운 문제에서 오답이 반복됐어요. " +

                "틀린 어려운 문제의 풀이를 확인하고 " +
                "비슷한 새로운 문제로 연습하세요. " +

                "문제 수가 적으므로 임시 판단입니다."
        };
    }

    // 2. 숙련도 60% 미만
    if (mastery < 60) {
        return {
            activityType: "concept",

            activityTitle:
                "핵심 개념 학습",

            activityGuide:
                "핵심 개념을 복습하고 새로운 기본 문제로 이해도를 확인하세요."
        };
    }

    // 3. 복습 단계
    if (signal?.nextAction === "review") {
        return {
            activityType: "review",

            activityTitle:
                "오답 재풀이 및 복습",

            activityGuide:
                "기존 오답을 다시 풀고 새로운 문제로 기억을 확인하세요."
        };
    }

    // 4. 다양한 문제 연습
    return {
        activityType: "practice",

        activityTitle:
            "다양한 유형의 문제 연습",

        activityGuide:
            "새로운 유형과 난이도의 문제를 풀어 부족한 부분을 확인하세요."
    };
}


// =====================================
// ScorePath 21-72
// 시험 대비 학습 전광판 데이터 V0.1
// =====================================

function buildScorePathLearningBoardV01(user, exam) {

    const signals =
        buildScorePathLearningSignalsV01(user, exam);

    const totalUnits =
        signals.length;

    // 풀이 근거가 일정 수준 확보된 단원
    const evidenceUnits =
        signals.filter(
            (item) =>
                item.evidenceLevel === "보통" ||
                item.evidenceLevel === "넓음"
        ).length;

    // 기록은 있지만 근거가 제한적인 단원
    const limitedUnits =
        signals.filter(
            (item) =>
                Number(item.uniqueAttempts) > 0 &&
                item.evidenceLevel === "제한적"
        ).length;

    // 풀이 기록이 없는 단원
    const unmeasuredUnits =
        signals.filter(
            (item) =>
                Number(item.uniqueAttempts) === 0
        ).length;

    // 시험범위 전체의 고유 문제 수
    const totalUniqueProblems =
        signals.reduce(
            (sum, item) =>
                sum +
                (Number(item.uniqueAttempts) || 0),
            0
        );

    // 단원별 풀이 근거 확보 비율
    const evidenceCoveragePercent =
        totalUnits > 0
            ? Math.round(
                (evidenceUnits / totalUnits) * 100
            )
            : null;

    // =====================================
    // ScorePath 21-96
    // 전광판: 실력 측정 현황과 목표 참고 기준
    // =====================================

    // 고유 문제 5개 이상으로
    // 숙련도 추정치가 계산된 단원
    const measuredSignals = signals.filter(
        (item) =>
            Number.isFinite(item.estimatedMastery)
    );

    const measuredUnits =
        measuredSignals.length;

    const needsMeasurementUnits =
        totalUnits - measuredUnits;

    // =====================================
    // 목표 점수 확인
    // =====================================

    // =====================================
    // ScorePath 21-322
    // 현재 시험 성적과 목표 점수 비교
    // =====================================

    // 미입력값을 0점으로 잘못 처리하지 않는다.
    const readExamScore = (value) => {

        if (
            value == null ||
            String(value).trim() === ""
        ) {
            return null;
        }

        const score =
            Number(value);

        return Number.isFinite(score) &&
            score >= 0 &&
            score <= 100

                ? score
                : null;
    };

    const targetScoreNumber =
        readExamScore(exam?.targetScore);

    const currentScoreNumber =
        readExamScore(exam?.currentScore);

    const hasTargetScore =
        targetScoreNumber !== null;

    const hasCurrentScore =
        currentScoreNumber !== null;

    // =====================================
    // 시험 점수끼리만 비교
    // =====================================

    // 개념 숙련도는 사용하지 않는다.
    const scoreGapPoints =
        hasCurrentScore && hasTargetScore

            ? Math.max(
                0,

                Math.round(
                    (
                        targetScoreNumber -
                        currentScoreNumber
                    ) * 100
                ) / 100
            )

            : null;

    // =====================================
    // ScorePath 21-316
    // 서로 다른 지표의 직접 비교 제거
    // =====================================

    // 개념 숙련도 추정치와 시험 목표 점수는 다른 척도다.
    // 목표 점수는 별도 필드로 유지하고,
    // 비교 차이로 취약 단원을 만들지 않는다.

    // =====================================
    // 전광판 학습 상태 메시지
    // =====================================

    const readinessMessage =
        totalUnits === 0
            ? "시험범위를 먼저 등록하세요"

            : measuredUnits === 0
                ? "숙련도 산출에 필요한 풀이 기록이 부족합니다"

                : evidenceUnits < totalUnits
                    ? "학습 근거가 부족한 단원이 남아 있습니다"

                    : "학습 근거 확보 · 시험점수 예측 모델은 검증 전입니다";

    // 현재 추천 학습 계획 가져오기
    const dailyPlan =
        buildScorePathDailyStudyPlanV01(user, exam);

        const firstSession =
        dailyPlan.sessions?.[0] || null;

    // =====================================
    // ScorePath 21-75
    // 첫 번째 추천 단원의 학습 근거
    // =====================================

        const firstSignal =
        firstSession
            ? signals.find(
                (item) =>
                    item.unit === firstSession.unit
            )
            : null;

    // =====================================
    // ScorePath 21-102
    // 공부 추천의 근거 수준 구분
    // =====================================

     // =====================================
    // ScorePath 21-209
    // 전광판 실력 확인 상태 안내
    // =====================================

    const evidenceNotice =
        !firstSession

            ? "오늘의 추천이 없습니다. 시험일·시험범위·공부시간을 확인하세요."

            : !firstSignal

                ? "학습 근거를 확인하지 못했습니다."

                : firstSignal.verificationStage === "unmeasured"

                    ? "현재 시험 풀이 기록이 없습니다. 기본 문제로 먼저 확인하세요. 과거 기록이 있다면 보조 근거로만 사용합니다."

                    : firstSignal.verificationStage === "initial"

                        ? firstSignal.earlyDirection === "study_concept"

                            ? `현재 고유 문제 ${
                                firstSignal.uniqueAttempts
                            }개 중 오답 ${
                                firstSignal.uniqueWrongCount
                            }개 · 관련 개념부터 공부하는 것을 임시 추천합니다.`

                            : firstSignal.earlyDirection === "practice_new"

                                ? `현재 고유 문제 ${
                                    firstSignal.uniqueAttempts
                                }개를 모두 맞혔습니다. 다른 유형의 문제로 학습을 확장하세요.`

                                : `현재 고유 문제 ${
                                    firstSignal.uniqueAttempts
                                }개 · 학습 방향이 불확실하므로 새로운 문제 1~2개로 짧게 확인하세요.`

                        : firstSignal.verificationStage === "difficulty_gap"

                            ? "숙련도는 참고용입니다. 난이도가 다른 새로운 문제로 추가 확인하세요."

                            : firstSignal.verificationStage === "provisional"

                                ? "초기 숙련도 참고치는 있지만 풀이 근거가 제한적입니다. 추가 문제로 확인하세요."

                                : "다양한 풀이 근거를 활용한 임시 추천입니다. 실제 점수 상승은 검증되지 않았습니다.";

    // =====================================
    // 시험일까지 남은 학습 가능시간 추정
    // =====================================

    const examDateText =
        String(exam?.examDate || "");

    const examTime =
        /^\d{4}-\d{2}-\d{2}$/.test(examDateText)
            ? new Date(
                `${examDateText}T00:00:00`
            ).getTime()
            : NaN;

    const today =
        new Date();

    today.setHours(0, 0, 0, 0);

    const remainingDays =
        Number.isFinite(examTime)
            ? Math.round(
                (examTime - today.getTime()) /
                86400000
            )
            : null;

    const dailyMinutes =
        Math.max(
            0,
            Math.floor(
                Number(
                    exam?.dailyStudyMinutes
                ) || 0
            )
        );

    // 하루 공부시간을 매일 지킨다는
    // 가정하에 계산한 계획상 총시간
        const remainingPlannedMinutes =
        remainingDays !== null &&
        remainingDays >= 0
            ? remainingDays * dailyMinutes
            : null;

    // =====================================
    // ScorePath 21-100
    // 최근 완료한 학습과 추천 변화 분석
    // =====================================

    const lastCompletedStudy = (
        Array.isArray(user.scorePathStudySessions)
            ? user.scorePathStudySessions
            : []
    )
        .filter((item) =>
            item.examId === safeText(exam?.id) &&
            item.status === "completed"
        )
        .sort((a, b) =>
            Number(b.completedAt || 0) -
            Number(a.completedAt || 0)
        )[0] || null;

    // 가장 최근 학습의 결과
    const lastResults =
        lastCompletedStudy?.results || {};

    // 학습 시작 당시 추천 1순위
    const previousTopUnit =
        safeText(
            lastCompletedStudy
                ?.recommendationAtStart
                ?.unit
        );

    // 현재 추천 1순위
    const currentTopUnit =
        safeText(firstSession?.unit);

    return {
        totalUnits,

        // =====================================
        // 전광판에 최근 학습 결과 전달
        // =====================================

        lastCompletedStudy:
            lastCompletedStudy
                ? {
                    unit:
                        safeText(lastCompletedStudy.unit),

                    completedAt:
                        Number(
                            lastCompletedStudy.completedAt
                        ) || null,

                    // 이번 학습의 문제 풀이 횟수
                    attempts:
                        Number(lastResults.attempts) || 0,

                    // 이번 학습에서 새롭게 푼 고유 문제
                    newUniqueAttempts:
                        Number(
                            lastResults.newUniqueAttempts
                        ) || 0,

                    // 이번 학습 정답률
                    accuracy:
                        typeof lastResults.accuracy === "number"
                            ? lastResults.accuracy
                            : null,

                    // 학습 전후 추정 숙련도 변화
                    masteryChangePp:
                        typeof lastResults.estimatedMasteryChangePp
                            === "number"
                            ? lastResults.estimatedMasteryChangePp
                            : null,

                    // =====================================
                    // 학습 전후 추천 1순위 비교
                    // =====================================

                           // =====================================
                    // ScorePath 21-173
                    // 단원 + 추천 활동 변화 비교
                    // =====================================

                    recommendationComparison:
                        previousTopUnit &&
                        currentTopUnit

                            ? (() => {

                                const beforeAction = safeText(
                                    lastCompletedStudy
                                        ?.recommendationAtStart
                                        ?.activityTitle
                                );

                                const afterAction = safeText(
                                    firstSession?.activityTitle
                                );

                                return {

                                    before: [
                                        previousTopUnit,
                                        beforeAction
                                    ]
                                        .filter(Boolean)
                                        .join(" · "),

                                    after: [
                                        currentTopUnit,
                                        afterAction
                                    ]
                                        .filter(Boolean)
                                        .join(" · "),

                                    changed:
                                        previousTopUnit !== currentTopUnit ||
                                        beforeAction !== afterAction
                                };

                            })()

                            : null
                }
                : null,

        evidenceUnits,

        limitedUnits,

        unmeasuredUnits,

        totalUniqueProblems,

        evidenceCoveragePercent,

        // =====================================
        // ScorePath 21-97
        // 시험 대비 상태 데이터
        // =====================================

        readiness: {

            // 숙련도 추정치가 있는 단원 수
            measuredUnits,

            // 숙련도 산출에 필요한 기록이
            // 아직 부족한 단원 수
            needsMeasurementUnits,

            // =====================================
            // ScorePath 21-323
            // 시험 점수 및 학습 방향 안내
            // =====================================

            targetScore:
                targetScoreNumber,

            currentScore:
                currentScoreNumber,

            scoreGapPoints,

            // 목표 점수 차이는
            // 단원 추천 우선순위에 직접 더하지 않는다.
            //
            // 공부 방향은 실제 풀이 근거의
            // 충분성에 따라 안내한다.

            goalSummary:
                (
                    !hasTargetScore

                        ? "목표 점수 미등록"

                        : !hasCurrentScore

                            ? "현재 성적 미입력 · 점수 차이 미산출"

                            : scoreGapPoints > 0

                                ? `입력한 현재 ${currentScoreNumber}점 · 목표까지 ${scoreGapPoints}점 차이`

                                : `입력한 현재 ${currentScoreNumber}점 · 목표 ${targetScoreNumber}점 이상(현재 성적 기준)`

                ) + " · " + (

                    totalUnits === 0

                        ? "시험범위 등록 필요"

                        : measuredUnits === 0

                            ? "기본 문제로 실력 확인 우선"

                            : evidenceUnits < totalUnits

                                ? "근거 부족 단원 추가 확인 권장"

                                : "학습 기록에 따라 약점 보완·복습"
                ),

            // ScorePath 21-317
            // 서로 다른 지표를 비교한 취약 단원 필드는 제공하지 않는다.

            // 현재 데이터 상태
            message:
                readinessMessage
        },

        // 실제 시험 점수 예측은 아직 검증되지 않음
        predictedScore: null,

        predictionMessage:
            totalUnits === 0
                ? "시험범위 등록 필요"
                : evidenceUnits < totalUnits
                    ? "예측 준비 중 · 학습 근거 부족"
                    : "예측 모델 검증 전",

                // =====================================
        // ScorePath 21-76
        // 남은 공부시간 및 추천 근거 반환
        // =====================================

        remainingDays,

        remainingPlannedMinutes,

        // 가장 먼저 추천하는 공부
        nextStudy:
            firstSession
                ? {
                    unit:
                        firstSession.unit,

                    minutes:
                        firstSession.minutes,

                                        activityTitle:
                        firstSession.activityTitle ||
                        "학습 진행",

                    // =====================================
                    // ScorePath 21-103
                    // 구체적인 공부 방법 연결
                    // =====================================

                    activityGuide:
                        firstSession.activityGuide ||
                        "추천한 단원의 새로운 문제를 풀고 결과를 확인하세요.",

                    // 추천 판단 근거 안내
                    evidenceNotice,

                    // 추천 엔진이 계산한 이유
                    reason:
                        firstSession.reason || "",

                    // 이 단원에 확보된 학습 근거
                    evidenceLevel:
                        firstSignal?.evidenceLevel ||
                        "제한적",

                    // 중복을 제외한 문제 개수
                    uniqueAttempts:
                        Number(
                            firstSignal?.uniqueAttempts
                        ) || 0
                }
                : null
    };
}


// =====================================
// ScorePath 21-8
// 하루 학습시간 자동 배분 V0.1
// =====================================

function buildScorePathDailyStudyPlanV01(user, exam) {

    // =====================================
    // ScorePath 21-40
    // 지난 시험 학습 계획 차단
    // =====================================

    const examDateText =
        String(exam?.examDate || "");

    const examDate =
        /^\d{4}-\d{2}-\d{2}$/.test(examDateText)
            ? new Date(`${examDateText}T00:00:00`)
            : null;

    const today =
        new Date();

    today.setHours(0, 0, 0, 0);

    const isPastExam =
        !examDate ||
        !Number.isFinite(examDate.getTime()) ||
        examDate.getTime() < today.getTime();

    if (isPastExam) {
        return {
            totalMinutes: 0,
            sessions: []
        };
    }

    const priorities =
        buildScorePathStudyPriorityV01(user, exam);

    const dailyMinutes =
        Math.floor(Number(exam?.dailyStudyMinutes));

    if (
        !Number.isFinite(dailyMinutes) ||
        dailyMinutes <= 0 ||
        priorities.length === 0
    ) {
        return {
            totalMinutes: 0,
            sessions: []
        };
    }

    // =====================================
    // ScorePath 21-295
    // 시험 계획: 가용 시간은 상한, 계획은 근거 기반
    // =====================================

    let remainingMinutes = dailyMinutes;
    const selected = [];
    const allocatedExtras = [];

    // 일반 전광판과 공통 원칙:
    // 추천 우선순위를 유지하고, 단원별 초기 소요시간만 배분한다.
    // 기존 서버가 산출한 estimatedMinutes를 재사용한다.
    for (const item of priorities.slice(0, 6)) {

        // 5분 미만의 자투리 시간은 별도 단원으로 나누지 않는다.
        // 전체 예산이 1~4분인 기존 시험은 첫 단원에 배정 가능
        if (remainingMinutes < 5 && selected.length > 0) break;
        if (remainingMinutes <= 0) break;

        const estimate = Number(item.estimatedMinutes);

        const baseMinutes =
            Number.isFinite(estimate) && estimate > 0
                ? Math.max(5, Math.round(estimate))
                : 15;

        const minutes = Math.min(remainingMinutes, baseMinutes);

        selected.push(item);

        // 기존 세션 생성 코드가 1 + allocatedExtras를 사용한다.
        allocatedExtras.push(minutes - 1);

        remainingMinutes -= minutes;
    }

    // 시간이 남으면 상위 단원의 추가 풀이에 한 번만 배정한다.
    // 추가 시간은 해당 단원의 초기 배정 시간 이내로 제한한다.
    for (let i = 0; i < Math.min(3, selected.length); i++) {

        if (remainingMinutes < 5) break;

        const initialMinutes = 1 + allocatedExtras[i];

        const extraCap =
            Math.floor(initialMinutes / 5) * 5;

        const extra =
            Math.min(remainingMinutes, extraCap);

        if (extra < 5) continue;

        allocatedExtras[i] += extra;

        remainingMinutes -= extra;
    }

    // 1~4분의 잔여분은 새로운 단원을 만들지 않고
    // 첫 단원에 합친다.
    if (
        remainingMinutes > 0 &&
        remainingMinutes < 5 &&
        selected.length
    ) {

        allocatedExtras[0] += remainingMinutes;

        remainingMinutes = 0;
    }

        // =====================================
    // ScorePath 21-110
    // 시험 D-day를 학습 활동 엔진에 전달
    // =====================================

    // 앞에서 검증한 시험일과 오늘 날짜를 사용
    const daysLeftForActivity =
        Math.round(
            (
                examDate.getTime() -
                today.getTime()
            ) / 86400000
        );

    const sessions = selected.map((item, index) => {

        const minutes =
            1 + allocatedExtras[index];

        // =====================================
        // 추천 공부 활동 연결
        // =====================================

        // =====================================
        // ScorePath 21-212
        // 공부시간을 학습 활동 결정에 반영
        // =====================================

        const studyActivity =
            buildScorePathStudyActivityV01(
                item,
                daysLeftForActivity,
                minutes
            );

        return {
            unit: item.unit,

            minutes,

            action: item.nextAction,

            // 구체적인 학습 활동
            activityType:
                studyActivity.activityType,

            activityTitle:
                studyActivity.activityTitle,

            activityGuide:
                studyActivity.activityGuide,

            // 기존 추천 정보 유지
            reason: item.reason,

            priorityScore:
                item.priorityScore
        };
    });

    // =====================================
    // ScorePath 21-296
    // 실제 계획과 남은 예산 구분
    // =====================================

    const plannedMinutes = sessions.reduce(
        (sum, item) => sum + item.minutes,
        0
    );

    return {

        // 실제 계획에 배정된 시간
        totalMinutes: plannedMinutes,

        // 사용자가 설정한 하루 공부 가능시간
        availableMinutes: dailyMinutes,

        // 아직 배정되지 않은 시간
        unallocatedMinutes: Math.max(           
            0,
            dailyMinutes - plannedMinutes
        ),

        sessions
    };
}

function groupNotesByWeakness(user) {
    const groups = {};

    const allNotes = [
        ...(Array.isArray(user.notes) ? user.notes : []),
        ...(Array.isArray(user.solvedNotes) ? user.solvedNotes : [])
    ];

    for (const note of allNotes) {
        const info = getWeaknessKey(note);

        // 약점을 분류할 근거가 전혀 없는 기록은
        // 개인 약점 계산에서 제외한다.
        //
        // 예:
        // Gemini JSON 파싱 실패 → fallback 분석 저장
        // weakConcept / weakConceptDetail /
        // problemType / errorType이 모두 비어 있음
        const hasWeaknessData =
            Boolean(info.weakConcept) ||
            Boolean(info.weakConceptDetail) ||
            Boolean(info.problemType) ||
            Boolean(info.errorType);

        if (!hasWeaknessData) {
            continue;
        }

        if (!groups[info.key]) {
            groups[info.key] = {
                key: info.key,

                subject: info.subject,
                unit: info.unit,

                weakConcept: info.weakConcept,
                weakConceptDetail: info.weakConceptDetail,

                problemTypes: [],
                errorTypes: [],

                notes: []
            };
        }

        const group = groups[info.key];

        if (
            info.problemType &&
            !group.problemTypes.includes(info.problemType)
        ) {
            group.problemTypes.push(info.problemType);
        }

        if (
            info.errorType &&
            !group.errorTypes.includes(info.errorType)
        ) {
            group.errorTypes.push(info.errorType);
        }

        group.notes.push(note);
    }

    return groups;
}

// ================================
// 약점 점수 계산
// ================================

function clampWeaknessScore(score) {
    return Math.max(0, Math.min(100, Math.round(score)));
}

function getWeaknessStatus(score) {
    if (score >= 60) {
        return "red";
    }

    if (score >= 30) {
        return "yellow";
    }

    return "green";
}

function calculateWeaknessGroup(group, user) {
    const notes = Array.isArray(group?.notes)
        ? group.notes
        : [];

    let wrongCount = 0;

    // 일반 복습 기록
    let normalCorrectCount = 0;
    let normalReviewWrongCount = 0;

    // 예약 복습 기록
    let spacedCorrectCount = 0;
    let spacedWrongCount = 0;

    // 약점 훈련 기록
    let trainingCorrectCount = 0;
    let trainingWrongCount = 0;


    // ================================
    // 1. 노트 기반 기록 합산
    // ================================

    for (const note of notes) {
        wrongCount += Math.max(
            0,
            Number(note?.repeatWrongCount || 0)
        );

        normalCorrectCount += Math.max(
            0,
            Number(note?.reviewCount || 0)
        );

        if (
            Number(note?.reviewCount || 0) > 0 &&
            safeText(note?.latestReviewResult) === "wrong"
        ) {
            normalReviewWrongCount += 1;
        }
    }


    // ================================
    // 2. 해당 약점의 학습 이벤트
    // ================================

    const weaknessEvents =
        (Array.isArray(user?.learningEvents)
            ? user.learningEvents
            : [])
        .filter((event) => {
            const eventInfo =
                getWeaknessKey(event);

            return eventInfo.key === group.key;
        })
        .sort(
            (a, b) =>
                Number(a.createdAt || 0) -
                Number(b.createdAt || 0)
        );


    // ================================
    // 3. 예약 복습 + 약점 훈련 결과 합산
    // ================================

    for (const event of weaknessEvents) {
        const eventType =
            safeText(event?.eventType);

        const result =
            safeText(event?.result);


        // 예약 복습
        if (eventType === "spaced_review") {
            if (result === "correct") {
                spacedCorrectCount += 1;
            } else if (result === "wrong") {
                spacedWrongCount += 1;
            }

            continue;
        }


        // 약점 훈련
        if (eventType === "weakness_training") {
            if (result === "correct") {
                trainingCorrectCount += 1;
            } else if (result === "wrong") {
                trainingWrongCount += 1;
            }
        }
    }


    // 일반 복습 + 예약 복습 + 약점 훈련
    const correctCount =
        normalCorrectCount +
        spacedCorrectCount +
        trainingCorrectCount;

    const reviewWrongCount =
        normalReviewWrongCount +
        spacedWrongCount +
        trainingWrongCount;


    // ================================
    // 4. 최근 연속 정답 계산
    // ================================

    let consecutiveCorrect = 0;

    for (
        let i = weaknessEvents.length - 1;
        i >= 0;
        i -= 1
    ) {
        const result =
            safeText(
                weaknessEvents[i]?.result
            );

        if (result === "correct") {
            consecutiveCorrect += 1;
            continue;
        }

        if (result === "wrong") {
            break;
        }
    }


    // ================================
    // 5. 약점 점수 계산
    // ================================

    let score = 0;

    // 첫 오답 +20
    // 이후 오답 한 번당 +8
    if (wrongCount > 0) {
        score += 20;

        if (wrongCount > 1) {
            score +=
                (wrongCount - 1) * 8;
        }
    }

    // 정답 1회당 -5
    score -=
        correctCount * 5;

    // 복습/훈련에서 다시 틀림 +10
    score +=
        reviewWrongCount * 10;


    // ================================
    // 6. 최근 연속 정답 보너스
    // ================================

    let streakBonus = 0;

    if (consecutiveCorrect >= 5) {
        streakBonus = 45;
    } else if (consecutiveCorrect === 4) {
        streakBonus = 35;
    } else if (consecutiveCorrect === 3) {
        streakBonus = 25;
    } else if (consecutiveCorrect === 2) {
        streakBonus = 15;
    }

    score -= streakBonus;

    const weaknessScore =
        clampWeaknessScore(score);


    // ================================
    // 7. 약점 정보 반환
    // ================================

    return {
        key: group.key,

        subject: group.subject,
        unit: group.unit,

        weakConcept:
            group.weakConcept,

        weakConceptDetail:
            group.weakConceptDetail,

        problemTypes:
            group.problemTypes,

        errorTypes:
            group.errorTypes,

        wrongCount,
        correctCount,
        reviewWrongCount,

        consecutiveCorrect,
        weaknessScore,

        status:
            getWeaknessStatus(
                weaknessScore
            ),

        updatedAt: now()
    };
}

// ================================
// 약점 프로필 생성
// ================================

function buildWeaknessProfile(user) {
    const groups = groupNotesByWeakness(user);
    const profile = {};

    for (const group of Object.values(groups)) {
        const weakness =
            calculateWeaknessGroup(group, user);

        if (!profile[weakness.subject]) {
            profile[weakness.subject] = {};
        }

        const label =
            weakness.weakConceptDetail ||
            weakness.weakConcept ||
            weakness.unit ||
            "분류되지 않은 약점";

        profile[weakness.subject][weakness.key] = {
            label,

            unit: weakness.unit,

            weakConcept:
                weakness.weakConcept,

            weakConceptDetail:
                weakness.weakConceptDetail,

            problemTypes:
                weakness.problemTypes,

            errorTypes:
                weakness.errorTypes,

            wrongCount:
                weakness.wrongCount,

            correctCount:
                weakness.correctCount,

            reviewWrongCount:
                weakness.reviewWrongCount,

            consecutiveCorrect:
                weakness.consecutiveCorrect,

            weaknessScore:
                weakness.weaknessScore,

            status:
                weakness.status,

            updatedAt:
                weakness.updatedAt
        };
    }

        return profile;
}

// ================================
// 5단계 - 복습 스케줄 시스템
// ================================

const REVIEW_INTERVAL_DAYS = {
    1: 1,
    2: 3,
    3: 7,
    4: 14,
    5: 30
};

function getReviewIntervalDays(stage) {
    return REVIEW_INTERVAL_DAYS[stage] || 0;
}

function addDays(timestamp, days) {
    return (
        Number(timestamp) +
        Number(days) * 24 * 60 * 60 * 1000
    );
}

// ================================
// 예약 복습 결과 처리
// ================================

function processScheduledReviewResult(
    user,
    weaknessKey,
    result
) {
    if (
        !user.reviewSchedule ||
        typeof user.reviewSchedule !== "object" ||
        Array.isArray(user.reviewSchedule)
    ) {
        return {
            processed: false,
            reason: "review_schedule_missing"
        };
    }

    const cleanWeaknessKey =
        safeText(weaknessKey);

    const schedule =
        user.reviewSchedule[cleanWeaknessKey];

    if (!schedule) {
        return {
            processed: false,
            reason: "schedule_not_found"
        };
    }

    const currentTime = now();

    // 아직 예정된 복습 시간이 되지 않았다면
    // 평소 재훈련으로 보고 복습 단계를 변경하지 않는다.
    if (
        Number(schedule.nextReviewAt || 0) > currentTime
    ) {
        return {
            processed: false,
            reason: "not_due_yet",
            schedule
        };
    }

    // 이미 극복한 약점은 다시 진행시키지 않는다.
    if (
        Number(schedule.stage || 1) >= 6 ||
        safeText(schedule.masteryStatus) === "mastered"
    ) {
        return {
            processed: false,
            reason: "already_mastered",
            schedule
        };
    }

    const normalizedResult =
        result === "correct"
            ? "correct"
            : "wrong";

    schedule.lastReviewAt = currentTime;
    schedule.updatedAt = currentTime;

    // ================================
    // 예약 복습 정답
    // ================================

    if (normalizedResult === "correct") {
        schedule.spacedCorrectCount =
            Number(
                schedule.spacedCorrectCount || 0
            ) + 1;

        const currentStage =
            Math.max(
                1,
                Number(schedule.stage || 1)
            );

        // stage 5의 30일 후 복습까지 맞혔다면 극복
        if (currentStage >= 5) {
            schedule.stage = 6;
            schedule.intervalDays = 0;
            schedule.nextReviewAt = null;
            schedule.masteryStatus = "mastered";

            return {
                processed: true,
                result: "correct",
                mastered: true,
                schedule
            };
        }

        const nextStage =
            currentStage + 1;

        const nextIntervalDays =
            getReviewIntervalDays(nextStage);

        schedule.stage = nextStage;
        schedule.intervalDays =
            nextIntervalDays;

        schedule.nextReviewAt =
            addDays(
                currentTime,
                nextIntervalDays
            );

        schedule.masteryStatus =
            "learning";

        return {
            processed: true,
            result: "correct",
            mastered: false,
            schedule
        };
    }

    // ================================
    // 예약 복습 오답
    // ================================

    schedule.spacedWrongCount =
        Number(
            schedule.spacedWrongCount || 0
        ) + 1;

    schedule.stage = 1;
    schedule.intervalDays =
        getReviewIntervalDays(1);

    schedule.nextReviewAt =
        addDays(
            currentTime,
            schedule.intervalDays
        );

    schedule.masteryStatus =
        "learning";

    return {
        processed: true,
        result: "wrong",
        mastered: false,
        schedule
    };
}

// 현재 weaknessProfile을 기준으로
// 없는 복습 스케줄만 새로 생성한다.
//
// 기존 스케줄은 건드리지 않는다.
// weaknessProfile 재계산 때문에
// 복습 진행도가 초기화되는 것을 막기 위함.
function syncReviewSchedule(user) {
    if (
        !user.reviewSchedule ||
        typeof user.reviewSchedule !== "object" ||
        Array.isArray(user.reviewSchedule)
    ) {
        user.reviewSchedule = {};
    }

    const profile =
        user.weaknessProfile &&
        typeof user.weaknessProfile === "object"
            ? user.weaknessProfile
            : {};

    const learningEvents =
        Array.isArray(user.learningEvents)
            ? user.learningEvents
            : [];

    const currentTime = now();

    for (const subjectProfile of Object.values(profile)) {
        if (!subjectProfile || typeof subjectProfile !== "object") {
            continue;
        }

        for (const [weaknessKey, weakness] of Object.entries(subjectProfile)) {
            if (!weaknessKey || !weakness) {
                continue;
            }

            const existingSchedule = user.reviewSchedule[weaknessKey];

            // 이미 복습 스케줄이 있는 약점
            if (existingSchedule) {
                const isMastered =
                    safeText(existingSchedule.masteryStatus) === "mastered" ||
                    Number(existingSchedule.stage || 0) >= 6;

                // 이미 극복한 약점이라면
                // 극복 이후 같은 약점을 다시 틀렸는지 확인한다.
                if (isMastered) {
                    const lastReviewAt =
                        Number(existingSchedule.lastReviewAt || 0);

                    const hasNewWrongAfterMastery =
                        learningEvents.some((event) => {
                            return (
                                safeText(event.weaknessKey) === weaknessKey &&
                                safeText(event.result) === "wrong" &&
                                Number(event.createdAt || 0) > lastReviewAt
                            );
                        });

                    // 극복 이후 새 오답 발생 → 약점 다시 활성화
                    if (hasNewWrongAfterMastery) {
                        const stage = 1;
                        const intervalDays =
                            getReviewIntervalDays(stage);

                        existingSchedule.stage = stage;
                        existingSchedule.intervalDays = intervalDays;
                        existingSchedule.nextReviewAt =
                            addDays(currentTime, intervalDays);
                        existingSchedule.masteryStatus = "learning";
                        existingSchedule.updatedAt = currentTime;
                    }
                }

                continue;
            }

            // 아직 복습 스케줄이 없는 새 약점
            const stage = 1;
            const intervalDays =
                getReviewIntervalDays(stage);

            user.reviewSchedule[weaknessKey] = {
                weaknessKey,

                subject:
                    safeText(weaknessKey.split("::")[0]) ||
                    "기타",

                label:
                    safeText(weakness.label) ||
                    safeText(weakness.weakConcept) ||
                    "분류되지 않은 약점",

                stage,
                intervalDays,

                nextReviewAt:
                    addDays(currentTime, intervalDays),

                lastReviewAt: null,

                spacedCorrectCount: 0,
                spacedWrongCount: 0,

                masteryStatus: "learning",

                createdAt: currentTime,
                updatedAt: currentTime
            };
        }
    }

    return user.reviewSchedule;
}

// ================================
// 약점 + 복습 스케줄 통합 갱신
// ================================

function refreshWeaknessSystem(user) {
    user.weaknessProfile =
        buildWeaknessProfile(user);

    syncReviewSchedule(user);

    return {
        weaknessProfile:
            user.weaknessProfile,

        reviewSchedule:
            user.reviewSchedule
    };
}

// ================================
// 학습 이벤트 기록
// ================================

function recordLearningEvent(
    user,
    note,
    result,
    eventType = "review",
    sourceType = "normal"
) {
    if (!Array.isArray(user.learningEvents)) {
        user.learningEvents = [];
    }

    if (!note) {
        return null;
    }

    const info = getWeaknessKey(note);

    // AI 분석 실패 등으로 약점 분류 정보가 전혀 없는 경우
    // 약점 이벤트로 기록하지 않는다.
    const hasWeaknessData =
        Boolean(info.weakConcept) ||
        Boolean(info.weakConceptDetail) ||
        Boolean(info.problemType) ||
        Boolean(info.errorType);

    if (!hasWeaknessData) {
        return null;
    }

    const normalizedResult =
        result === "correct"
            ? "correct"
            : "wrong";

    const cleanEventType =
        safeText(eventType) || "review";

    const cleanSourceType =
        safeText(sourceType) || "normal";

    const currentTime = now();

    // 같은 문제에 대해 같은 결과 요청이 거의 동시에 중복으로 들어오면
    // 학습 이벤트를 두 번 기록하지 않는다.
    const duplicateWindowMs = 3000;

    const duplicateEvent =
        [...user.learningEvents]
            .reverse()
            .find((existingEvent) => {
                return (
                    safeText(existingEvent.noteId) === safeText(note.id) &&
                    safeText(existingEvent.weaknessKey) === info.key &&
                    safeText(existingEvent.result) === normalizedResult &&
                    safeText(existingEvent.eventType) === cleanEventType &&
                    safeText(existingEvent.sourceType) === cleanSourceType &&
                    currentTime -
                        Number(existingEvent.createdAt || 0) <=
                        duplicateWindowMs
                );
            });

    if (duplicateEvent) {
        console.log("DUPLICATE LEARNING EVENT SKIPPED:", {
            noteId: note.id,
            weaknessKey: info.key,
            result: normalizedResult,
            eventType: cleanEventType,
            sourceType: cleanSourceType
        });

        return duplicateEvent;
    }

    const event = {
        id: randomUUID(),

        noteId: safeText(note.id),

        weaknessKey: info.key,

        subject: info.subject,
        unit: info.unit,

        weakConcept: info.weakConcept,
        weakConceptDetail: info.weakConceptDetail,

        problemType: info.problemType,
        errorType: info.errorType,

        result: normalizedResult,

        eventType: cleanEventType,
        sourceType: cleanSourceType,

        createdAt: currentTime
    };

    user.learningEvents.push(event);

    return event;
}


// =====================================
// 7단계 - 시험 위험도 계산 엔진
// =====================================

function buildExamRiskProfile(
    user,
    subject,
    exam = null
) {
    ensureUserShape(user);
    refreshWeaknessSystem(user);

    const cleanSubject =
        safeText(subject);

    const currentTime = now();

    const DAY_MS =
        24 * 60 * 60 * 1000;


    // =====================================
    // 1. 시험 범위
    // =====================================

    const examRange =
        Array.isArray(exam?.examRange)
            ? exam.examRange
                .map((item) =>
                    normalizeWeaknessLabel(item)
                )
                .filter(Boolean)
            : [];


    const normalizedExamRange =
        examRange.map((item) =>
            item
                .toLowerCase()
                .replace(/\s+/g, "")
        );


    // =====================================
    // 시험범위 일치 여부
    // =====================================

    const isInExamRange = (weakness) => {

        // 시험 정보가 전달되지 않았거나
        // 시험범위가 없는 기존 기능은
        // 과목 전체를 대상으로 유지
        if (normalizedExamRange.length === 0) {
            return true;
        }


        const candidates = [
            weakness?.unit,
            weakness?.label,
            weakness?.weakConcept,
            weakness?.weakConceptDetail,

            ...(Array.isArray(
                weakness?.problemTypes
            )
                ? weakness.problemTypes
                : [])
        ]
            .map((value) =>
                normalizeWeaknessLabel(value)
                    .toLowerCase()
                    .replace(/\s+/g, "")
            )
            .filter(Boolean);


        return normalizedExamRange.some(
            (rangeItem) =>
                candidates.some(
                    (candidate) =>
                        candidate === rangeItem ||
                        candidate.includes(
                            rangeItem
                        ) ||
                        rangeItem.includes(
                            candidate
                        )
                )
        );
    };


    // =====================================
    // 2. 해당 과목 약점
    // =====================================

    const subjectProfile =
        user.weaknessProfile?.[
            cleanSubject
        ] || {};


    // =====================================
    // 3. 해당 과목 학습 이벤트
    // =====================================

    const subjectEvents =
        (
            Array.isArray(
                user.learningEvents
            )
                ? user.learningEvents
                : []
        )
            .filter(
                (event) =>
                    safeText(
                        event.subject
                    ) === cleanSubject
            );


    // =====================================
    // 4. 해당 과목 문제
    // =====================================

    const allSubjectNotes = [
        ...(
            Array.isArray(user.notes)
                ? user.notes
                : []
        ),

        ...(
            Array.isArray(
                user.solvedNotes
            )
                ? user.solvedNotes
                : []
        )
    ]
        .filter(
            (note) =>
                safeText(
                    note.subject
                ) === cleanSubject
        );


    // =====================================
    // 시험범위 문제만 필터
    // =====================================

    const subjectNotes =
        allSubjectNotes.filter(
            (note) => {

                if (
                    normalizedExamRange.length === 0
                ) {
                    return true;
                }


                const noteInfo =
                    getWeaknessKey(note);


                return isInExamRange({
                    unit:
                        safeText(note.unit),

                    label:
                        noteInfo.concept,

                    weakConcept:
                        safeText(
                            note.weakConcept
                        ),

                    weakConceptDetail:
                        safeText(
                            note.weakConceptDetail
                        ),

                    problemTypes: [
                        safeText(
                            note.problemType
                        )
                    ]
                });
            }
        );


    // =====================================
    // 5. 문제 유형별 오답 빈도
    // =====================================

    const problemTypeWrongCounts = {};


    for (const note of subjectNotes) {

        const problemType =
            safeText(
                note.problemType
            );


        if (!problemType) {
            continue;
        }


        const wrongCount =
            Math.max(
                0,
                Number(
                    note.repeatWrongCount ||
                    0
                )
            );


        problemTypeWrongCounts[
            problemType
        ] =
            Number(
                problemTypeWrongCounts[
                    problemType
                ] || 0
            ) +
            wrongCount;
    }


    const maxProblemTypeWrongCount =
        Math.max(
            1,

            ...Object.values(
                problemTypeWrongCounts
            ).map(Number)
        );


    // =====================================
    // 6. 약점별 위험도
    // =====================================

    const weaknesses =
        Object.entries(
            subjectProfile
        )
            .map(
                ([
                    weaknessKey,
                    weakness
                ]) => {

                    const problemTypes =
                        Array.isArray(
                            weakness.problemTypes
                        )
                            ? weakness
                                .problemTypes
                                .filter(Boolean)
                            : [];


                    const rangeMatched =
                        isInExamRange({
                            ...weakness,
                            problemTypes
                        });


                    // 시험범위가 등록되어 있는데
                    // 해당 약점이 범위 밖이면 제외
                    if (
                        normalizedExamRange.length >
                            0 &&
                        !rangeMatched
                    ) {
                        return null;
                    }


                    const wrongCount =
                        Math.max(
                            0,
                            Number(
                                weakness.wrongCount ||
                                0
                            )
                        );


                    const weaknessScore =
                        Math.max(
                            0,
                            Math.min(
                                100,
                                Number(
                                    weakness
                                        .weaknessScore ||
                                    0
                                )
                            )
                        );


                    // =====================================
                    // A. 반복 오답
                    // 최대 30
                    // =====================================

                    const repeatWrongScore =
                        Math.min(
                            30,
                            wrongCount * 10
                        );


                    // =====================================
                    // B. 현재 약점
                    // 최대 30
                    // =====================================

                    const weaknessRiskScore =
                        Math.round(
                            weaknessScore *
                            0.3
                        );


                    // =====================================
                    // C. 최근 오답
                    // 최대 20
                    // =====================================

                    const wrongEvents =
                        subjectEvents
                            .filter(
                                (event) =>
                                    safeText(
                                        event
                                            .weaknessKey
                                    ) ===
                                        weaknessKey &&
                                    safeText(
                                        event.result
                                    ) ===
                                        "wrong"
                            )
                            .sort(
                                (a, b) =>
                                    Number(
                                        b.createdAt ||
                                        0
                                    ) -
                                    Number(
                                        a.createdAt ||
                                        0
                                    )
                            );


                    const latestWrongAt =
                        wrongEvents.length >
                        0
                            ? Number(
                                wrongEvents[0]
                                    .createdAt ||
                                0
                            )
                            : 0;


                    let recentWrongScore =
                        0;

                    let daysSinceLastWrong =
                        null;


                    if (latestWrongAt > 0) {

                        daysSinceLastWrong =
                            Math.max(
                                0,
                                Math.floor(
                                    (
                                        currentTime -
                                        latestWrongAt
                                    ) /
                                    DAY_MS
                                )
                            );


                        if (
                            daysSinceLastWrong <=
                            3
                        ) {
                            recentWrongScore =
                                20;

                        } else if (
                            daysSinceLastWrong <=
                            7
                        ) {
                            recentWrongScore =
                                15;

                        } else if (
                            daysSinceLastWrong <=
                            14
                        ) {
                            recentWrongScore =
                                10;

                        } else if (
                            daysSinceLastWrong <=
                            30
                        ) {
                            recentWrongScore =
                                5;
                        }
                    }


                    // =====================================
                    // D. 취약 문제 유형
                    // 최대 20
                    // =====================================

                    let vulnerableTypeScore =
                        0;

                    let mostVulnerableProblemType =
                        "";


                    for (
                        const problemType of
                        problemTypes
                    ) {

                        const typeWrongCount =
                            Number(
                                problemTypeWrongCounts[
                                    problemType
                                ] || 0
                            );


                        const typeScore =
                            Math.round(
                                (
                                    typeWrongCount /
                                    maxProblemTypeWrongCount
                                ) *
                                20
                            );


                        if (
                            typeScore >
                            vulnerableTypeScore
                        ) {
                            vulnerableTypeScore =
                                typeScore;

                            mostVulnerableProblemType =
                                problemType;
                        }
                    }


                    vulnerableTypeScore =
                        Math.min(
                            20,
                            vulnerableTypeScore
                        );


                    // =====================================
                    // 총 위험도
                    // =====================================

                    const riskScore =
                        Math.max(
                            0,
                            Math.min(
                                100,

                                repeatWrongScore +
                                weaknessRiskScore +
                                recentWrongScore +
                                vulnerableTypeScore
                            )
                        );


                    let riskLevel =
                        "green";


                    if (riskScore >= 70) {
                        riskLevel =
                            "red";

                    } else if (
                        riskScore >= 40
                    ) {
                        riskLevel =
                            "yellow";
                    }


                    return {
                        weaknessKey,

                        label:
                            safeText(
                                weakness.label
                            ) ||
                            safeText(
                                weakness
                                    .weakConceptDetail
                            ) ||
                            safeText(
                                weakness
                                    .weakConcept
                            ) ||
                            "분류되지 않은 약점",

                        unit:
                            safeText(
                                weakness.unit
                            ),

                        weakConcept:
                            safeText(
                                weakness
                                    .weakConcept
                            ),

                        weakConceptDetail:
                            safeText(
                                weakness
                                    .weakConceptDetail
                            ),

                        problemTypes,

                        mostVulnerableProblemType,

                        wrongCount,
                        weaknessScore,

                        latestWrongAt:
                            latestWrongAt ||
                            null,

                        daysSinceLastWrong,

                        // ScorePath
                        inExamRange:
                            rangeMatched,

                        scores: {
                            repeatWrong:
                                repeatWrongScore,

                            weakness:
                                weaknessRiskScore,

                            recentWrong:
                                recentWrongScore,

                            problemType:
                                vulnerableTypeScore
                        },

                        riskScore,
                        riskLevel
                    };
                }
            )
            .filter(Boolean)
            .sort(
                (a, b) => {

                    if (
                        b.riskScore !==
                        a.riskScore
                    ) {
                        return (
                            b.riskScore -
                            a.riskScore
                        );
                    }


                    if (
                        b.wrongCount !==
                        a.wrongCount
                    ) {
                        return (
                            b.wrongCount -
                            a.wrongCount
                        );
                    }


                    return (
                        b.weaknessScore -
                        a.weaknessScore
                    );
                }
            );


    // =====================================
    // 7. 취약 문제 유형 순위
    // =====================================

    const vulnerableProblemTypes =
        Object.entries(
            problemTypeWrongCounts
        )
            .map(
                ([
                    problemType,
                    wrongCount
                ]) => ({
                    problemType,

                    wrongCount:
                        Number(
                            wrongCount ||
                            0
                        )
                })
            )
            .sort(
                (a, b) =>
                    b.wrongCount -
                    a.wrongCount
            );


    // =====================================
    // 최종 시험 위험도 프로필
    // =====================================

    return {
        subject:
            cleanSubject,

        examRange,

        rangeFilterEnabled:
            examRange.length > 0,

        totalWeaknesses:
            weaknesses.length,

        highRiskCount:
            weaknesses.filter(
                (item) =>
                    item.riskLevel ===
                    "red"
            ).length,

        mediumRiskCount:
            weaknesses.filter(
                (item) =>
                    item.riskLevel ===
                    "yellow"
            ).length,

        lowRiskCount:
            weaknesses.filter(
                (item) =>
                    item.riskLevel ===
                    "green"
            ).length,

        weaknesses,

        vulnerableProblemTypes,

        calculatedAt:
            currentTime
    };
}


// =====================================
// 7-1 ScorePath 시험범위 측정 상태 엔진
// =====================================

function buildExamRangeStatus(user, exam) {
    ensureUserShape(user);
    refreshWeaknessSystem(user);


    const subject =
        safeText(exam?.subject);

    const examId =
        safeText(exam?.id);


    const examRange =
        Array.isArray(exam?.examRange)
            ? exam.examRange
                .map((item) =>
                    normalizeWeaknessLabel(item)
                )
                .filter(Boolean)
            : [];


    // =====================================
    // 1. 비교용 문자열 정규화
    // =====================================

    const normalizeRangeText = (value) =>
        normalizeWeaknessLabel(value)
            .toLowerCase()
            .replace(/\s+/g, "");


    // =====================================
    // 2. 해당 과목의 기존 문제 데이터
    // =====================================

    const subjectNotes = [
        ...(
            Array.isArray(user.notes)
                ? user.notes
                : []
        ),

        ...(
            Array.isArray(user.solvedNotes)
                ? user.solvedNotes
                : []
        )
    ]
        .filter(
            (note) =>
                safeText(note.subject) ===
                subject
        );


    // =====================================
    // 3. 이 시험에서 완료된 진단 기록
    // =====================================

    const completedDiagnosisAttempts =
        Object.values(
            user.examDiagnosisAttempts ||
            {}
        )
            .filter(
                (attempt) =>
                    safeText(
                        attempt?.examId
                    ) === examId &&

                    safeText(
                        attempt?.subject
                    ) === subject &&

                    safeText(
                        attempt?.status
                    ) === "completed"
            );


    // =====================================
    // 4. 시험범위 하나씩 측정 상태 계산
    // =====================================

    const ranges =
        examRange.map((rangeName) => {

            const normalizedRange =
                normalizeRangeText(
                    rangeName
                );


            // =====================================
            // 기존 오답/학습 데이터
            // =====================================

            const matchedNotes =
                subjectNotes.filter(
                    (note) => {

                        const info =
                            getWeaknessKey(note);


                        const candidates = [
                            note.unit,
                            note.weakConcept,
                            note.weakConceptDetail,
                            note.problemType,
                            info.concept
                        ]
                            .map(
                                normalizeRangeText
                            )
                            .filter(Boolean);


                        return candidates.some(
                            (candidate) =>
                                candidate ===
                                    normalizedRange ||

                                candidate.includes(
                                    normalizedRange
                                ) ||

                                normalizedRange.includes(
                                    candidate
                                )
                        );
                    }
                );


            // =====================================
            // 해당 범위의 완료된 진단 기록
            // =====================================

            const matchedDiagnosisAttempts =
                completedDiagnosisAttempts
                    .filter(
                        (attempt) =>
                            normalizeRangeText(
                                attempt?.rangeName
                            ) ===
                            normalizedRange
                    );


            // =====================================
            // 5. 기존 문제 기반 evidence
            // =====================================

            const noteEvidenceCount =
                matchedNotes.length;


            const wrongEvidenceCount =
                matchedNotes.reduce(
                    (total, note) =>
                        total +
                        Math.max(
                            0,
                            Number(
                                note.repeatWrongCount ||
                                0
                            )
                        ),
                    0
                );


            const reviewEvidenceCount =
                matchedNotes.reduce(
                    (total, note) =>
                        total +
                        Math.max(
                            0,
                            Number(
                                note.reviewCount ||
                                0
                            )
                        ),
                    0
                );


            // =====================================
            // 6. 진단 기반 evidence
            // =====================================

            const diagnosisEvidenceCount =
                matchedDiagnosisAttempts.reduce(
                    (total, attempt) => {

                        const answers =
                            Array.isArray(
                                attempt?.answers
                            )
                                ? attempt.answers
                                : [];


                        return (
                            total +
                            answers.length
                        );
                    },
                    0
                );


            const diagnosisCorrectCount =
                matchedDiagnosisAttempts.reduce(
                    (total, attempt) =>
                        total +
                        Math.max(
                            0,
                            Number(
                                attempt?.correctCount ||
                                0
                            )
                        ),
                    0
                );


            const diagnosisWrongCount =
                matchedDiagnosisAttempts.reduce(
                    (total, attempt) =>
                        total +
                        Math.max(
                            0,
                            Number(
                                attempt?.wrongCount ||
                                0
                            )
                        ),
                    0
                );


            const evidenceCount =
                noteEvidenceCount +
                diagnosisEvidenceCount;


            // =====================================
            // 7. 기존 약점 점수
            // =====================================

            const weaknessScores = [];


            for (const note of matchedNotes) {

                const info =
                    getWeaknessKey(note);


                const profile =
                    user
                        .weaknessProfile?.[
                            subject
                        ]?.[
                            info.key
                        ];


                const score =
                    Number(
                        profile?.weaknessScore
                    );


                if (Number.isFinite(score)) {
                    weaknessScores.push(
                        score
                    );
                }
            }


            const noteAverageWeaknessScore =
                weaknessScores.length > 0
                    ? Math.round(
                        weaknessScores.reduce(
                            (total, score) =>
                                total + score,
                            0
                        ) /
                        weaknessScores.length
                    )
                    : null;


            // =====================================
            // 8. 진단 결과를 약점 점수로 변환
            //
            // 0/3 → 100
            // 1/3 → 75
            // 2/3 → 45
            // 3/3 → 15
            //
            // V1용 초기 규칙이며
            // 실제 사용자 데이터가 쌓이면 조정한다.
            // =====================================

            let diagnosisWeaknessScore =
                null;


            if (diagnosisEvidenceCount > 0) {

                const diagnosisAccuracy =
                    diagnosisCorrectCount /
                    diagnosisEvidenceCount;


                if (diagnosisAccuracy === 0) {

                    diagnosisWeaknessScore =
                        100;

                } else if (
                    diagnosisAccuracy <=
                    (1 / 3)
                ) {

                    diagnosisWeaknessScore =
                        75;

                } else if (
                    diagnosisAccuracy <=
                    (2 / 3)
                ) {

                    diagnosisWeaknessScore =
                        45;

                } else {

                    diagnosisWeaknessScore =
                        15;
                }
            }


            // =====================================
            // 9. 최종 약점 점수
            // =====================================

            let averageWeaknessScore =
                null;


            if (
                noteAverageWeaknessScore !== null &&
                diagnosisWeaknessScore !== null
            ) {

                averageWeaknessScore =
                    Math.round(
                        (
                            noteAverageWeaknessScore +
                            diagnosisWeaknessScore
                        ) / 2
                    );

            } else if (
                diagnosisWeaknessScore !== null
            ) {

                averageWeaknessScore =
                    diagnosisWeaknessScore;

            } else if (
                noteAverageWeaknessScore !== null
            ) {

                averageWeaknessScore =
                    noteAverageWeaknessScore;
            }


            // =====================================
            // ScorePath 21-60
            // 실제 풀이 기록 기반 측정 상태 V0.2
            // =====================================

            // 기존 숙련도 엔진의 결과 활용
            const learningSignal =
                buildScorePathLearningSignalsV01(
                    user,
                    exam
                ).find(
                    (signal) =>
                        normalizeRangeText(
                            signal.unit
                        ) === normalizedRange
                );

            // 서로 다른 문제를 푼 개수
            const uniqueAttempts =
                Math.max(
                    0,
                    Number(
                        learningSignal?.uniqueAttempts
                    ) || 0
                );

            // 풀이 근거의 충분성
            const evidenceLevel =
                learningSignal?.evidenceLevel ||
                "제한적";

            const hasEnoughEvidence =
                uniqueAttempts >= 12 &&
                (
                    evidenceLevel === "보통" ||
                    evidenceLevel === "넓음"
                );

            let measurementStatus =
                "unmeasured";

            let measurementLabel =
                "미측정";

            if (hasEnoughEvidence) {

                measurementStatus =
                    "measured";

                measurementLabel =
                    "풀이 근거 확보";

            } else if (
                uniqueAttempts > 0 ||
                evidenceCount > 0
            ) {

                measurementStatus =
                    "insufficient";

                measurementLabel =
                    "추가 근거 필요";
            }

            // 기존 응답 구조와 호환성 유지
            // 이름은 유지하지만 AI 진단을
            // 반드시 해야 한다는 의미는 아님
            const diagnosisRequired =
                measurementStatus !==
                "measured";

            // 기존 노트와 풀이 기록은 중복될 수
            // 있으므로 단순 합산하지 않는다.
            const displayEvidenceCount =
                Math.max(
                    evidenceCount,
                    uniqueAttempts
                );

            return {
                rangeName,

                measurementStatus,
                measurementLabel,

                diagnosisRequired,

                evidenceCount:
                    displayEvidenceCount,

                noteEvidenceCount,

                diagnosisEvidenceCount,
                diagnosisCorrectCount,
                diagnosisWrongCount,

                wrongEvidenceCount,
                reviewEvidenceCount,

                diagnosisWeaknessScore,

                averageWeaknessScore
            };
        });


    // =====================================
    // 12. 시험 전체 측정 현황
    // =====================================

    const measuredCount =
        ranges.filter(
            (item) =>
                item.measurementStatus ===
                "measured"
        ).length;


    const insufficientCount =
        ranges.filter(
            (item) =>
                item.measurementStatus ===
                "insufficient"
        ).length;


    const unmeasuredCount =
        ranges.filter(
            (item) =>
                item.measurementStatus ===
                "unmeasured"
        ).length;


    const diagnosisRequiredCount =
        ranges.filter(
            (item) =>
                item.diagnosisRequired
        ).length;


    return {
        examId:
            safeText(exam?.id),

        examName:
            safeText(exam?.name),

        subject,

        totalRangeCount:
            ranges.length,

        measuredCount,
        insufficientCount,
        unmeasuredCount,
        diagnosisRequiredCount,

        ranges,

        calculatedAt:
            now()
    };
}

function buildExamStudySet(user, exam) {
    ensureUserShape(user);
    refreshWeaknessSystem(user);

    const subject = safeText(exam?.subject);

    const DAY_MS =
        24 * 60 * 60 * 1000;

    const currentTime = now();

    // =====================================
    // 1. 달력 기준 D-Day 계산
    // =====================================

    const today = new Date(currentTime);

    const todayStart =
        new Date(
            today.getFullYear(),
            today.getMonth(),
            today.getDate()
        ).getTime();

    const examParts =
        safeText(exam?.examDate)
            .split("-")
            .map(Number);

    let examStart = NaN;

    if (
        examParts.length === 3 &&
        examParts.every(Number.isFinite)
    ) {
        examStart =
            new Date(
                examParts[0],
                examParts[1] - 1,
                examParts[2]
            ).getTime();
    }

    const daysLeft =
        Number.isFinite(examStart)
            ? Math.max(
                0,
                Math.round(
                    (examStart - todayStart) /
                    DAY_MS
                )
            )
            : 0;


    // =====================================
    // 2. D-Day별 오늘 문제 수
    // =====================================

    let targetCount = 6;

    if (daysLeft === 0) {
        targetCount = 5;

    } else if (daysLeft <= 3) {
        targetCount = 12;

    } else if (daysLeft <= 7) {
        targetCount = 10;

    } else if (daysLeft <= 14) {
        targetCount = 8;
    }


    // =====================================
    // 3. 해당 과목 위험도
    // =====================================

    const riskProfile =
        buildExamRiskProfile(
            user,
            subject
        );

    const riskMap = new Map(
        (riskProfile.weaknesses || [])
            .map((item) => [
                safeText(item.weaknessKey),
                item
            ])
    );


    const vulnerableTypeMap = new Map(
        (riskProfile.vulnerableProblemTypes || [])
            .map((item, index) => [
                safeText(item.problemType),
                {
                    wrongCount:
                        Number(
                            item.wrongCount || 0
                        ),

                    rank:
                        index + 1
                }
            ])
    );


    // =====================================
    // 4. 후보 문제
    //
    // notes를 우선하고,
    // 부족할 때 solvedNotes를 사용
    // =====================================

    const candidates = [];

    const addCandidate = (
        note,
        source,
        sourcePriority
    ) => {
        if (!note) {
            return;
        }

        if (
            safeText(note.subject) !==
            subject
        ) {
            return;
        }

        const problem =
            safeText(note.problem);

        const correctAnswer =
            safeText(note.correctAnswer);

        if (
            !problem ||
            !correctAnswer
        ) {
            return;
        }


        const weaknessInfo =
            getWeaknessKey(note);

        const risk =
            riskMap.get(
                weaknessInfo.key
            );


        const repeatWrongCount =
            Math.max(
                0,
                Number(
                    note.repeatWrongCount || 0
                )
            );


        const weaknessRisk =
            Math.max(
                0,
                Number(
                    risk?.riskScore || 0
                )
            );


        // 최근성 판단
        const latestActivityAt =
            Math.max(
                Number(
                    note.updatedAt || 0
                ),
                Number(
                    note.createdAt || 0
                )
            );


        let recencyScore = 0;

        if (latestActivityAt > 0) {
            const daysSinceActivity =
                Math.max(
                    0,
                    Math.floor(
                        (
                            currentTime -
                            latestActivityAt
                        ) /
                        DAY_MS
                    )
                );


            if (daysSinceActivity <= 3) {
                recencyScore = 20;

            } else if (
                daysSinceActivity <= 7
            ) {
                recencyScore = 15;

            } else if (
                daysSinceActivity <= 14
            ) {
                recencyScore = 10;

            } else if (
                daysSinceActivity <= 30
            ) {
                recencyScore = 5;
            }
        }


        const problemType =
            safeText(note.problemType);

        const vulnerableType =
            vulnerableTypeMap.get(
                problemType
            );


        let problemTypeScore = 0;

        if (vulnerableType) {
            if (vulnerableType.rank === 1) {
                problemTypeScore = 20;

            } else if (
                vulnerableType.rank <= 3
            ) {
                problemTypeScore = 15;

            } else {
                problemTypeScore = 8;
            }
        }


        // =====================================
        // 문제 선택 우선순위 점수
        //
        // 미해결 문제 우선       최대 30
        // 반복 오답             최대 30
        // 약점 위험도           최대 30
        // 최근성                최대 20
        // 취약 문제유형         최대 20
        // =====================================

        const unresolvedScore =
            source === "wrong"
                ? 30
                : 0;

        const repeatScore =
            Math.min(
                30,
                repeatWrongCount * 10
            );

        const weaknessScore =
            Math.round(
                weaknessRisk * 0.3
            );


        const priorityScore =
            unresolvedScore +
            repeatScore +
            weaknessScore +
            recencyScore +
            problemTypeScore;


        candidates.push({
            noteId:
                safeText(note.id),

            subject,

            problem,

            // 브라우저에 정답을 노출하지 않는다.
            weaknessKey:
                weaknessInfo.key,

            unit:
                safeText(note.unit),

            weakConcept:
                safeText(note.weakConcept),

            weakConceptDetail:
                safeText(
                    note.weakConceptDetail
                ),

            problemType,

            difficulty:
                safeText(note.difficulty),

            repeatWrongCount,

            riskScore:
                weaknessRisk,

            riskLevel:
                safeText(
                    risk?.riskLevel
                ) || "green",

            source,

            sourcePriority,

            priorityScore,

            scoreBreakdown: {
                unresolved:
                    unresolvedScore,

                repeatWrong:
                    repeatScore,

                weakness:
                    weaknessScore,

                recent:
                    recencyScore,

                problemType:
                    problemTypeScore
            },

            latestActivityAt
        });
    };


    for (
        const note of
        Array.isArray(user.notes)
            ? user.notes
            : []
    ) {
        addCandidate(
            note,
            "wrong",
            2
        );
    }


    for (
        const note of
        Array.isArray(user.solvedNotes)
            ? user.solvedNotes
            : []
    ) {
        addCandidate(
            note,
            "solved",
            1
        );
    }


    // =====================================
    // 5. 같은 문제 중복 제거
    // =====================================

    const uniqueMap =
        new Map();

    for (const candidate of candidates) {
        const duplicateKey =
            [
                candidate.subject,
                candidate.problem
                    .toLowerCase()
                    .replace(/\s+/g, " ")
                    .trim()
            ].join("::");


        const existing =
            uniqueMap.get(
                duplicateKey
            );


        if (
            !existing ||
            candidate.priorityScore >
                existing.priorityScore ||
            (
                candidate.priorityScore ===
                    existing.priorityScore &&
                candidate.sourcePriority >
                    existing.sourcePriority
            )
        ) {
            uniqueMap.set(
                duplicateKey,
                candidate
            );
        }
    }


    const uniqueCandidates =
        [...uniqueMap.values()];


    // =====================================
    // 6. 최종 정렬
    // =====================================

    uniqueCandidates.sort(
        (a, b) => {

            // 아직 틀린 문제 우선
            if (
                b.sourcePriority !==
                a.sourcePriority
            ) {
                return (
                    b.sourcePriority -
                    a.sourcePriority
                );
            }


            // 종합 점수
            if (
                b.priorityScore !==
                a.priorityScore
            ) {
                return (
                    b.priorityScore -
                    a.priorityScore
                );
            }


            // 반복 오답
            if (
                b.repeatWrongCount !==
                a.repeatWrongCount
            ) {
                return (
                    b.repeatWrongCount -
                    a.repeatWrongCount
                );
            }


            // 약점 위험도
            if (
                b.riskScore !==
                a.riskScore
            ) {
                return (
                    b.riskScore -
                    a.riskScore
                );
            }


            return (
                b.latestActivityAt -
                a.latestActivityAt
            );
        }
    );


    // =====================================
    // 7. 목표 문제 수만 선택
    // =====================================

    const problems =
        uniqueCandidates.slice(
            0,
            targetCount
        );


    return {
        examId:
            safeText(exam?.id),

        examName:
            safeText(exam?.name),

        subject,

        examDate:
            safeText(exam?.examDate),

        daysLeft,

        targetCount,

        actualCount:
            problems.length,

        problems,

        summary: {
            unresolvedCount:
                problems.filter(
                    (item) =>
                        item.source ===
                        "wrong"
                ).length,

            solvedBackupCount:
                problems.filter(
                    (item) =>
                        item.source ===
                        "solved"
                ).length,

            highRiskProblemCount:
                problems.filter(
                    (item) =>
                        item.riskLevel ===
                        "red"
                ).length
        },

        generatedAt:
            currentTime
    };
}

function sanitizeUser(user) {
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
        createdAt: user.createdAt,
        subjects: user.subjects,
    };
}

function getProblemIdentity(problem, problemImageKey = "") {
    const textProblem = safeText(problem);

    if (textProblem) {
        return textProblem;
    }

    const imageKey = safeText(problemImageKey);

    if (imageKey) {
        return `__image__:${imageKey}`;
    }

    return "";
}

function noteKey(subject, problem, correctAnswer) {
    return `${subject}::${problem}::${correctAnswer}`;
}

function analysisKey(subject, problem, userAnswer, correctAnswer, plan) {
    return `${plan}::${subject}::${problem}::${userAnswer}::${correctAnswer}`;
}

function advancedProblemKey(subject, problem) {
    return `${subject}::${problem}`.toLowerCase();
}

async function permanentlyCleanupNote(
    user,
    note
) {
    if (!note) return;

    const problemIdentity =
        getProblemIdentity(
            note.problem,
            note.problemImageKey
        );

    const cacheTarget =
        `::${note.subject}::${problemIdentity}::`;

    Object.keys(
        user.analysisCache || {}
    ).forEach((key) => {
        if (
            key.includes(
                cacheTarget
            )
        ) {
            delete user.analysisCache[
                key
            ];
        }
    });

    const advancedKey =
        advancedProblemKey(
            note.subject,
            problemIdentity
        );

    user.usageAdvanced.usedKeys =
        (
            user.usageAdvanced
                .usedKeys || []
        ).filter(
            (key) =>
                key !== advancedKey
        );

    if (note.advancedProblem) {
        delete user
            .advancedAnswerMap[
                note.advancedProblem
            ];
    }

    if (
        note.sourceType ===
            "advanced" &&
        note.problem
    ) {
        delete user
            .advancedAnswerMap[
                note.problem
            ];
    }

    const problemImageKey =
        safeText(
            note.problemImageKey
        );

    if (
        problemImageKey &&
        problemImageKey.startsWith(
            "problem-images/"
        )
    ) {
        try {
            await r2Client.send(
                new DeleteObjectCommand({
                    Bucket:
                        r2BucketName,

                    Key:
                        problemImageKey
                })
            );

            console.log(
                "R2 PROBLEM IMAGE DELETED:",
                problemImageKey
            );

        } catch (error) {
            console.error(
                "R2 PROBLEM IMAGE DELETE ERROR:",
                {
                    problemImageKey,
                    error
                }
            );

            throw new Error(
                "문제 사진 영구삭제에 실패했습니다."
            );
        }
    }
}

function shiftNumber(value, amount) {
    const n = Number(value);
    if (Number.isNaN(n)) return value;
    return String(n + amount);
}

function replaceExpression(text, idx) {
    let changed = text;

    const replacements = [
        ["더하시오", idx % 2 === 0 ? "구하시오" : "계산하시오"],
        ["빼시오", idx % 2 === 0 ? "구하시오" : "계산하시오"],
        ["구하시오", idx % 2 === 0 ? "구해보시오" : "풀이하시오"],
        ["옳은 것을 고르시오", idx % 2 === 0 ? "맞는 것을 고르시오" : "알맞은 것을 고르시오"],
        ["틀린 것을 고르시오", idx % 2 === 0 ? "알맞지 않은 것을 고르시오" : "틀린 답을 고르시오"]
    ];

    replacements.forEach(([from, to]) => {
        if (changed.includes(from)) {
            changed = changed.replace(from, to);
        }
    });

    return changed;
}

function createVariantProblem(problem, idx) {
    let changed = safeText(problem);

    if (!changed) {
        return `비슷한 유형의 문제 ${idx + 1}: 같은 개념으로 직접 한 문제 만들어 보세요.`;
    }

    let replacedCount = 0;

    changed = changed.replace(/-?\d+(\.\d+)?/g, (match) => {
        if (replacedCount >= 3) return match;
        replacedCount += 1;
        return shiftNumber(match, idx + 2);
    });

    const replacementsByIdx = [
        [
            ["구하시오", "값을 계산하시오"],
            ["옳은 것을 고르시오", "맞는 것을 찾으시오"],
            ["설명하시오", "이유를 간단히 쓰시오"]
        ],
        [
            ["구하시오", "풀이 후 답하시오"],
            ["옳은 것을 고르시오", "알맞은 것을 선택하시오"],
            ["설명하시오", "풀이 과정을 짧게 쓰시오"]
        ],
        [
            ["구하시오", "조건을 보고 답하시오"],
            ["옳은 것을 고르시오", "보기 중 맞는 답을 고르시오"],
            ["설명하시오", "근거를 한 줄로 쓰시오"]
        ]
    ];

    const replacementSet = replacementsByIdx[idx % replacementsByIdx.length];

    replacementSet.forEach(([from, to]) => {
        if (changed.includes(from)) {
            changed = changed.replace(from, to);
        }
    });

    if (idx === 0) {
        changed = `${changed} 단, 조건 하나를 추가해 생각하시오.`;
    } else if (idx === 1) {
        changed = `${changed} 이번에는 풀이 순서를 먼저 정리한 뒤 답하시오.`;
    } else {
        changed = `${changed} 같은 개념을 쓰되 표현을 바꾸어 다시 풀어보시오.`;
    }

    return changed;
}

function makeFallbackSimilarProblems(problem, count) {
    const result = [];
    const used = new Set();

    for (let i = 0; i < count; i += 1) {
        const variant = createVariantProblem(problem, i);
        if (!used.has(variant)) {
            used.add(variant);
            result.push(variant);
        }
    }

    while (result.length < count) {
        result.push(`비슷한 유형의 추가 문제 ${result.length + 1}: 같은 개념으로 직접 만들어 보세요.`);
    }

    return result.slice(0, count);
}

function makeFallbackAdvancedProblem(problem) {
    const base = safeText(problem);

    if (!base) {
        return "응용문제: 같은 개념을 활용하되 조건이 하나 더 들어간 문제를 직접 만들어 보세요.";
    }

    let advanced = createVariantProblem(base, 3);

    advanced = advanced.replace(/설명하시오/g, "이유를 간단히 쓰시오");
    advanced = advanced.replace(/풀이 이유를 한 줄로 설명하시오/g, "풀이 이유를 한 줄로 쓰시오");

    if (!advanced.includes("추가 조건")) {
        advanced += "\n추가 조건: 답만 쓰지 말고 이유를 한 줄 덧붙이시오.";
    }

    return advanced;
}

function makeFallbackAnalysis(problem, userAnswer, correctAnswer, plan) {
   const similarProblems = [];
    const isCorrect = safeText(userAnswer) === safeText(correctAnswer);

    if (isCorrect) {
        return {
            reason: "정답입니다. 풀이 방향이 맞았습니다.",
            concept: "핵심 개념을 올바르게 적용했습니다.",
            solution: "비슷한 문제를 1~2개 더 풀어 정확도를 유지하세요.",
            similarProblems
        };
    }

    if (plan === "free") {
        return {
            reason: "정답과 다릅니다. 계산 또는 개념 적용에서 실수가 있었을 가능성이 큽니다.",
            concept: "핵심 개념을 짧게 다시 확인해야 합니다.",
            solution: "개념을 다시 보고 유사문제 1개를 더 풀어보세요.",
            similarProblems
        };
    }

    if (plan === "premium5900") {
        return {
            reason: "정답과 다릅니다. 조건 해석이나 적용 순서에서 실수했을 수 있습니다.",
            concept: "필요한 개념을 먼저 정리하고 문제 조건과 연결해야 합니다.",
            solution: "풀이 순서를 짧게 적고 유사문제 2개를 이어서 풀어보세요.",
            similarProblems
        };
    }

    return {
        reason: "정답과 다릅니다. 개념 부족과 조건 해석 실수가 함께 있었을 가능성이 있습니다.",
        concept: "핵심 개념을 먼저 정리한 뒤 조건을 단계별로 연결하는 연습이 필요합니다.",
        solution: "왜 틀렸는지 한 줄로 적고 유사문제와 응용문제까지 이어서 풀어보세요.",
        similarProblems
    };
}

function sanitizeReason(userAnswer, verifiedAnswer) {
    return `입력한 답(${userAnswer})은 확인된 정답(${verifiedAnswer})과 일치하지 않습니다. 문제의 핵심 조건과 풀이 과정을 다시 확인해 보세요.`;
}

const ERROR_TYPES = new Set([
    "개념 미숙",
    "계산 실수",
    "조건 해석 오류",
    "공식 적용 오류",
    "문제 유형 미숙",
    "단순 실수",
    "문제 이해 부족"
]);

const DIFFICULTIES = new Set([
    "쉬움",
    "보통",
    "어려움"
]);

function normalizeErrorType(value) {
    const text = safeText(value);

    if (!text) {
        return "";
    }

    if (ERROR_TYPES.has(text)) {
        return text;
    }

    const aliases = {
        "개념 부족": "개념 미숙",
        "개념 이해 부족": "개념 미숙",
        "개념 오류": "개념 미숙",

        "계산 오류": "계산 실수",
        "연산 실수": "계산 실수",
        "연산 오류": "계산 실수",

        "조건 해석 실수": "조건 해석 오류",
        "조건 이해 오류": "조건 해석 오류",

        "공식 적용 실수": "공식 적용 오류",
        "공식 사용 오류": "공식 적용 오류",

        "유형 미숙": "문제 유형 미숙",
        "유형 이해 부족": "문제 유형 미숙",

        "단순 계산 실수": "단순 실수",
        "부주의": "단순 실수",

        "문제 해석 오류": "문제 이해 부족",
        "문제 이해 오류": "문제 이해 부족"
    };

    return aliases[text] || "";
}

function normalizeDifficulty(value) {
    const text = safeText(value);

    if (!text) {
        return "";
    }

    if (DIFFICULTIES.has(text)) {
        return text;
    }

    const aliases = {
        "하": "쉬움",
        "낮음": "쉬움",
        "쉬운": "쉬움",
        "쉬운 문제": "쉬움",

        "중": "보통",
        "중간": "보통",
        "보통 난이도": "보통",
        "중간 난이도": "보통",

        "상": "어려움",
        "높음": "어려움",
        "어려운": "어려움",
        "어려운 문제": "어려움"
    };

    return aliases[text] || "";
}

function buildAnalyzePrompt(problem, userAnswer, verifiedAnswer, plan) {
    const similarCount = getPlanRule(plan).similarCount;

    const planGuide =
        plan === "free"
            ? "concept는 핵심 개념을 1문장으로 작성하고, solution은 정답에 도달하는 핵심 과정이 빠지지 않게 간결하게 작성한다."
            : "concept는 핵심 개념을 1문장으로 작성한다. solution은 정답에 도달하는 핵심 과정과 최종 답을 최대 2문장으로 작성한다.";

const similarRoleGuide =
    (similarCount === 1
        ? `- similarProblem1: 원문과 같은 핵심 개념, 해결 방법, 난이도를 유지하고 숫자나 핵심 단어만 바꾼 쌍둥이 문제로 만든다.`
        : similarCount === 2
        ? `- similarProblem1: 원문과 같은 핵심 개념, 해결 방법, 난이도를 유지하고 숫자나 핵심 단어만 바꾼 쌍둥이 문제로 만든다.
- similarProblem2: 같은 핵심 개념과 난이도를 유지하면서 질문 방식이나 선택지 구조를 가볍게 바꾼다.`
        : `- similarProblem1: 원문과 같은 핵심 개념, 해결 방법, 난이도를 유지하고 숫자나 핵심 단어만 바꾼 쌍둥이 문제로 만든다.
- similarProblem2: 같은 핵심 개념과 난이도를 유지하면서 질문 방식이나 선택지 구조를 가볍게 바꾼다.
- similarProblem3: 같은 핵심 개념이 시험에서 흔히 출제되는 대표적인 표준 유형으로 만든다. 실제 기출문제를 그대로 복제하지 않는다.`)
    + `
- 다양성보다 문제와 정답의 정확성을 우선한다.
- 변형 때문에 문제가 복잡하거나 불확실해지면 더 단순하게 만든다.
- 유사문제가 객관식이면 similarAnswer는 반드시 해당 유사문제의 실제 정답 선택지 내용을 그대로 반환한다.
- 정답 선택지의 표현을 요약하거나 바꿔 쓰거나 동의어로 변경하지 않는다.
- 예: 정답 선택지가 "③ 회사가 보유한 재고상품"이면 similarAnswer는 "회사가 보유한 재고상품"으로 반환한다.
- 객관식이 아니라면 similarAnswer에는 실제 정답을 반환한다.`;
    const similarJson =
        similarCount === 1
            ? `"similarProblem1": "",
  "similarAnswer1": ""`
            : similarCount === 2
            ? `"similarProblem1": "",
  "similarAnswer1": "",
  "similarProblem2": "",
  "similarAnswer2": ""`
            : `"similarProblem1": "",
  "similarAnswer1": "",
  "similarProblem2": "",
  "similarAnswer2": "",
  "similarProblem3": "",
  "similarAnswer3": ""`;

    return `
문제:
${problem}

검증된 정답:
${verifiedAnswer}

학생 답:
${userAnswer}

먼저 문제의 분야와 문제 유형을 파악한 뒤 그 분야에 맞는 방법으로 문제를 독립적으로 해결한다.
검증된 정답은 설명의 최종 일치 여부를 확인하는 기준으로 사용한다.

작성 규칙:
- 학교 교과목에 한정하지 않는다.
- 자격증, 전공, 기술, 프로그래밍, 경제, 회계, 역사, 언어 등 다양한 학습 문제를 문제 자체의 분야에 맞게 처리한다.
- concept에는 이 문제를 해결하는 데 실제로 필요한 핵심 개념, 원리, 정의, 규칙 또는 판단 기준을 작성한다.
- solution에는 문제 유형에 맞는 해결 과정을 작성한다.
- 계산 문제는 필요한 식, 계산, 단위와 조건을 확인한다.
- 개념·이론 문제는 관련 정의나 원리를 근거로 판단한다.
- 객관식 문제는 선택지의 의미를 확인하고 정답이 되는 근거를 설명한다.
- 프로그래밍 문제는 코드의 동작, 조건, 실행 결과 또는 관련 개념을 근거로 판단한다.
- 전문·자격증 문제는 해당 분야의 정의, 규칙, 공식 또는 원리를 우선 적용한다.
- 문제에 없는 사실, 조건, 수치 또는 학생의 실수 원인을 임의로 만들어내지 않는다.
- solution의 최종 결론은 반드시 검증된 정답 ${verifiedAnswer}와 일치해야 한다.
- 일치하지 않으면 내부적으로 다시 판단한 뒤 작성한다.
- Latex와 백슬래시는 쓰지 말고 수식은 일반 텍스트로 작성한다.
- ${planGuide}

유사문제 규칙:
- 모든 유사문제는 원문을 해결하는 데 필요한 핵심 개념을 그대로 사용한다.
- 문제의 분야와 학습 수준을 유지한다.

- similarProblem1은 원문과 매우 비슷하게 만들어 기본 개념을 반복 연습하게 한다.
- similarProblem1은 숫자, 변수, 대상 또는 핵심 단어 정도만 바꿀 수 있다.

- similarProblem2는 같은 핵심 개념을 유지하면서 질문 방식, 조건, 사례 또는 선택지 구조 중 일부를 바꾼다.
- similarProblem2는 원문이나 similarProblem1과 단순히 숫자나 변수 이름만 바꾼 복제품이 되지 않도록 한다.

- similarProblem3은 같은 핵심 개념이 실제 시험에서 주로 사용되는 대표적인 표준 문제 형태로 만든다.
- similarProblem3은 가능하면 원문 및 similarProblem1과 질문 형태까지 완전히 같게 만들지 않는다.

- 계산 문제는 수치나 조건을 바꿀 수 있다.
- 개념 문제는 사례, 상황, 질문 방식 또는 선택지를 문제의 역할에 맞게 바꿀 수 있다.
- 프로그래밍 및 전문 분야 문제는 실제 해당 분야에서 사용하는 규칙과 자연스러운 문제 형식을 유지한다.

- 새로운 핵심 개념을 추가하지 않는다.
- 원문보다 지나치게 어렵게 만들지 않는다.
- 다양성보다 문제의 성립과 정답의 정확성을 우선한다.
- 각 문제는 주어진 정보만으로 답이 하나로 결정되어야 한다.
- 객관식이면 선택지를 모두 포함하고 실제 정답이 선택지에 정확히 하나 있어야 한다.
- 각 유사문제를 내부적으로 직접 해결하여 정답이 성립하는지 확인한다.
- 각 문제를 내부적으로 직접 풀어 확인한 실제 정답을 corresponding similarAnswer에 작성한다.
- similarAnswer에는 객관식 번호가 아니라 실제 정답 선택지 내용을 작성한다.
- errorReason에는 학생 답과 검증된 정답을 비교하여 왜 틀렸는지 구체적으로 작성한다.
- 학생의 생각 과정이 주어지지 않았으므로 확인할 수 없는 원인을 사실처럼 단정하지 않는다.
- weakConcept에는 이 문제에서 부족했을 가능성이 가장 높은 핵심 개념을 작성한다.
- errorType은 반드시 다음 중 하나만 사용한다:
  개념 미숙, 계산 실수, 조건 해석 오류, 공식 적용 오류, 문제 유형 미숙, 단순 실수, 문제 이해 부족
- problemType에는 문제의 구체적인 유형을 작성한다.
${similarRoleGuide}

아래 JSON만 출력한다:
{
  "errorReason": "",
"unit": "",
"weakConcept": "",
"weakConceptDetail": "",
"errorType": "",
"errorDetail": "",
"problemType": "",
"difficulty": "",
"concept": "",
"solution": "",
  ${similarJson}
}
`;
}

// async function requestOpenAIAnswer(problem, apiKey) {
//     const response = await fetch("https://api.openai.com/v1/chat/completions", {
//         method: "POST",
//         headers: {
//             "Authorization": `Bearer ${apiKey}`,
//             "Content-Type": "application/json"
//         },
//         body: JSON.stringify({
//     model: "gpt-5-mini",
// reasoning_effort: "minimal",

//           response_format: {
//     type: "json_object"
// },

// messages: [
//     {
//         role: "system",
//         content: `
// 너는 문제의 실제 정답을 독립적으로 구하는 정답 검증 AI다.
// 학생의 답은 보지 않고 문제만 풀어라.

// 규칙:
// 1. 문제의 분야와 의도를 파악하고 적절한 공식·정의·조건을 적용한다.
// 2. 단순 계산뿐 아니라 단위, 조건, 수량의 의미를 정확히 구분한다.
// 3. 답을 구한 뒤 계산과 조건을 한 번 검산한다.
// 4. 공식 사용 시 변수와 문제의 수량이 올바르게 대응하는지 확인한다.
// 5. 전문 분야 문제는 일반 수학 공식을 기계적으로 적용하지 말고 해당 분야의 정의와 관계를 따른다.
// 6. 충분한 근거가 있을 때만 confident=true로 한다.
// 7. 확실하지 않으면 답을 추측하지 말고 confident=false로 한다.
// `
//     },
//     {
//         role: "user",
//         content: `
// [문제]
// ${problem}

// 문제를 처음부터 풀어 최종 정답을 구하고, 같은 문제를 다시 검산하여 checkAnswer를 결정해라.

// 규칙:
// - aiAnswer에는 첫 계산의 최종 정답만 작성한다.
// - checkAnswer에는 재검산한 최종 정답만 작성한다.
// - 숫자 문제는 가능한 한 숫자와 필요한 단위만 작성한다.
// - 두 결과를 억지로 같게 만들지 않는다.
// - 두 결과가 다르거나 정답을 확정할 수 없으면 confident=false로 한다.
// - 풀이와 설명은 출력하지 않는다.
// - 반드시 JSON만 출력한다.

// 출력 형식:
// {
//   "aiAnswer": "",
//   "checkAnswer": "",
//   "confident": true
// }
// `
//     }
// ],

// // temperature: 0,
// max_completion_tokens: 800
//         })
//     });

//     const data = await response.json();
//     console.log("ANSWER FINISH:", data?.choices?.[0]?.finish_reason);
// console.log("ANSWER USAGE:", data?.usage);
// console.log("ANSWER MESSAGE:", data?.choices?.[0]?.message);

//     if (!response.ok) {
//         throw new Error(JSON.stringify(data));
//     }

//     const content = data?.choices?.[0]?.message?.content;

//     if (!content) {
//         throw new Error("정답 검증 AI의 응답이 없습니다.");
//     }

//     console.log("ANSWER RAW:", content);

//     let parsed;

//     try {
//         parsed = JSON.parse(content);
//     } catch {
//         throw new Error("정답 검증 AI의 JSON 형식이 올바르지 않습니다.");
//     }

// return {
//     aiAnswer: safeText(parsed.aiAnswer),
//     checkAnswer: safeText(parsed.checkAnswer),
//     confident: parsed.confident === true
// };
// }

// =====================================
// ScorePath 진단 문제 생성
// =====================================

async function generateExamDiagnosisProblems(
    subject,
    rangeName
) {
    const geminiApiKey =
        process.env.GEMINI_API_KEY;


    if (!geminiApiKey) {
        throw new Error(
            "GEMINI_API_KEY가 없습니다."
        );
    }


    const cleanSubject =
        safeText(subject);

    const cleanRangeName =
        safeText(rangeName);


    if (
        !cleanSubject ||
        !cleanRangeName
    ) {
        throw new Error(
            "진단 과목 또는 시험범위가 없습니다."
        );
    }


    const prompt = `
너는 학생의 현재 실력을 측정하기 위한 진단 문제를 만드는 AI다.

[과목]
${cleanSubject}

[시험범위]
${cleanRangeName}

목표:
이 시험범위에 대한 학생의 현재 이해도를 적은 문제 수로 측정한다.

정확히 3개의 진단 문제를 만든다.

문제 역할:

1번:
- 해당 시험범위의 가장 기본적인 개념, 정의, 공식 또는 원리를 확인한다.
- 불필요하게 어렵게 만들지 않는다.

2번:
- 기본 개념을 실제 문제에 적용할 수 있는지 확인한다.
- 1번보다 한 단계 높은 적용 문제로 만든다.

3번:
- 학교 시험에서 나올 수 있는 대표적인 표준 적용 문제로 만든다.
- 지나친 심화 문제나 특수한 함정 문제는 만들지 않는다.

공통 규칙:
- 세 문제 모두 "${cleanRangeName}" 범위 안에서 출제한다.
- 다른 단원의 지식이 핵심 풀이가 되지 않게 한다.
- 학생의 현재 실력을 측정하는 데 필요한 대표적인 문제를 만든다.
- 문제마다 정답이 하나로 명확하게 결정되어야 한다.
- 문제 자체에 필요한 모든 조건을 포함한다.
- 실제 기출문제를 그대로 복사하지 않는다.
- 저작권이 있는 문제를 재현하지 않는다.
- 문제와 정답의 정확성을 다양성보다 우선한다.
- 각 문제를 생성한 뒤 내부적으로 직접 풀어서 정답을 확인한다.
- Latex와 백슬래시는 사용하지 않는다.
- 수식은 일반 텍스트로 작성한다.

객관식 문제를 만들 경우:
- 모든 선택지를 문제 문자열 안에 포함한다.
- 선택지는 ① ② ③ ④ ⑤ 형식을 사용한다.
- 정답 선택지는 정확히 하나만 존재해야 한다.
- correctAnswer에는 정답 선택지 번호만 쓴다.
- 예: ③이 정답이면 "3"

주관식 문제를 만들 경우:
- correctAnswer에는 최종 답만 작성한다.
- 불필요한 설명을 넣지 않는다.

difficulty는 반드시 다음 중 하나:
"쉬움", "보통", "어려움"

role은 반드시 다음 중 하나:
"basic", "application", "exam"

반드시 JSON 객체 하나만 출력한다.

{
  "problems": [
    {
      "role": "basic",
      "difficulty": "쉬움",
      "problem": "",
      "correctAnswer": ""
    },
    {
      "role": "application",
      "difficulty": "보통",
      "problem": "",
      "correctAnswer": ""
    },
    {
      "role": "exam",
      "difficulty": "보통",
      "problem": "",
      "correctAnswer": ""
    }
  ]
}
`.trim();


    let response;


    for (
        let attempt = 1;
        attempt <= 3;
        attempt++
    ) {
        response = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
            {
                signal:
                    AbortSignal.timeout(
                        30000
                    ),

                method:
                    "POST",

                headers: {
                    "Content-Type":
                        "application/json",

                    "x-goog-api-key":
                        geminiApiKey
                },

                body:
                    JSON.stringify({
                        contents: [
                            {
                                role:
                                    "user",

                                parts: [
                                    {
                                        text:
                                            prompt
                                    }
                                ]
                            }
                        ],

                        generationConfig: {
                            responseMimeType:
                                "application/json",

                            maxOutputTokens:
                                1800,

                            thinkingConfig: {
                                thinkingLevel:
                                    "low"
                            }
                        }
                    })
            }
        );


        if (response.ok) {
            break;
        }


        const errorText =
            await response.text();


        console.error(
            "DIAGNOSIS GENERATION ERROR:",
            {
                attempt,
                status:
                    response.status,
                errorText
            }
        );


        if (attempt === 3) {
            throw new Error(
                "진단 문제 생성 AI 호출에 실패했습니다."
            );
        }
    }


    const data =
        await response.json();


    // =====================================
    // ScorePath 21-159
    // 진단 문제 생성 토큰 기록
    // =====================================

    recordScorePathAiUsageV01({

        provider: "gemini",

        model: "gemini-3.1-flash-lite",

        purpose: "diagnosis_generation",

        httpOk: response.ok,

        usage: data?.usageMetadata

    });


    const raw =
        data?.candidates?.[0]
            ?.content?.parts?.[0]
            ?.text;


    if (!raw) {
        throw new Error(
            "진단 문제 생성 AI의 응답이 없습니다."
        );
    }


    const parsed =
        safeParseAiJson(
            raw,
            "진단 문제 생성 AI"
        );


    const rawProblems =
        Array.isArray(
            parsed?.problems
        )
            ? parsed.problems
            : [];


    if (rawProblems.length !== 3) {
        throw new Error(
            "진단 문제는 정확히 3개여야 합니다."
        );
    }


    const expectedRoles = [
        "basic",
        "application",
        "exam"
    ];


    const problems =
        rawProblems.map(
            (item, index) => {

                const problem =
                    safeText(
                        item?.problem
                    );

                const correctAnswer =
                    safeText(
                        item?.correctAnswer
                    );

                const difficulty =
                    normalizeDifficulty(
                        item?.difficulty
                    );


                if (
                    !problem ||
                    !correctAnswer
                ) {
                    throw new Error(
                        `진단 ${index + 1}번 문제 정보가 올바르지 않습니다.`
                    );
                }


                return {
                    id:
                        randomUUID(),

                    role:
                        expectedRoles[
                            index
                        ],

                    difficulty:
                        difficulty ||
                        (
                            index === 0
                                ? "쉬움"
                                : "보통"
                        ),

                    problem,

                    correctAnswer
                };
            }
        );


    return problems;
}

async function requestOpenAIAnswer(
    problem,
    userAnswer,
    plan,
    apiKey,
    problemImageBase64 = "",
    problemImageContentType = ""
) {
    const geminiApiKey =
        process.env.GEMINI_API_KEY;

    if (!geminiApiKey) {
        throw new Error(
            "GEMINI_API_KEY가 없습니다."
        );
    }

    const similarCount =
        getPlanRule(plan).similarCount;

    const hasProblemImage =
    Boolean(
        safeText(problemImageBase64)
    );

const choiceNumbers =
    getMultipleChoiceNumbers(problem);

const isMultipleChoice =
    choiceNumbers.length >= 2;

/*
 * 텍스트 문제는 서버가 객관식 여부를 판단할 수 있다.
 *
 * 사진 문제는 서버가 이미지 속 선택지를 직접 읽지 않으므로
 * Gemini가 이미지 자체를 보고 객관식/주관식을 판단한다.
 */
    const similarJson =
        similarCount === 1
            ? `"similarProblem1": "",
"similarAnswer1": ""`
            : similarCount === 2
            ? `"similarProblem1": "",
"similarAnswer1": "",
"similarProblem2": "",
"similarAnswer2": ""`
            : `"similarProblem1": "",
"similarAnswer1": "",
"similarProblem2": "",
"similarAnswer2": "",
"similarProblem3": "",
"similarAnswer3": ""`;

    const answerRule =
        isMultipleChoice
            ? `
이 문제는 객관식이다.

정답 출력 규칙:
- 문제를 먼저 풀어서 실제 결과를 구한다.
- derivedAnswer에는 선택지 번호를 고르기 직전에 얻은 실제 결과만 작성한다.
- derivedAnswer는 aiAnswer를 복사하거나 재검산한 두 번째 정답이 아니다.
- 계산 문제라면 계산으로 얻은 최종 값 또는 식을 작성한다.
- ㄱ/ㄴ/ㄷ 문제라면 실제로 옳다고 판단한 항목만 작성한다.
  예: "ㄴ", "ㄱ, ㄴ"
- 일반 개념 문제라면 정답 선택지의 핵심 내용을 작성한다.
- derivedAnswer에는 "1번", "②" 같은 선택지 번호를 쓰지 않는다.

- derivedAnswer를 실제 선택지와 대조한 뒤 aiAnswer를 결정한다.
- aiAnswer에는 정답 선택지 번호만 작성한다.
- 예: 정답이 ④이면 "4"만 작성한다.
- "④", "4번", "④ 0.1", "4. 0.1"처럼 작성하지 않는다.
- 선택지 내용이나 계산값을 aiAnswer에 붙이지 않는다.
- 반드시 실제 존재하는 선택지 번호 중 하나만 사용한다.
`
            : `
이 문제는 주관식이다.

정답 출력 규칙:
- 문제를 직접 풀어 최종 결과를 구한다.
- derivedAnswer에는 풀이에서 실제로 얻은 최종 결과를 작성한다.
- aiAnswer에는 최종 답만 작성한다.
- 불필요한 설명을 aiAnswer에 넣지 않는다.
- 존재하지 않는 선택지 번호를 붙이지 않는다.
`;

    const prompt = `
학생 오답 분석 및 정답 검증을 수행한다.

[문제]
${problem}

[학생 답]
${userAnswer}

작업:
1. 학생 답과 무관하게 문제를 처음부터 직접 푼다.
2. 문제 조건, 계산, 공식, 단위와 선택지를 확인한다.
3. 풀이에서 실제로 도출한 결과를 derivedAnswer에 작성한다.
4. 객관식이면 derivedAnswer를 선택지와 대조해서 aiAnswer를 결정한다.
5. 그 과정에 맞는 짧고 정확한 solution을 작성한다.
6. 정답을 충분히 확정할 수 있을 때만 confident=true로 한다.
7. 학생 답이 틀렸다면 문제와 학생 답에서 직접 확인되는 내용만 분석한다.
8. 단원, 약점, 오류 유형, 문제 유형, 난이도, 핵심 개념을 작성한다.
9. 같은 핵심 개념의 유사문제 ${similarCount}개와 정답을 만든다.

${answerRule}

중요:
- derivedAnswer와 aiAnswer는 서로 다른 역할이다.
- derivedAnswer는 "정답을 한 번 더 추측한 값"이 아니다.
- derivedAnswer는 풀이 과정 자체에서 얻어진 계산값, 식, 참인 항목 또는 정답 내용을 기록한다.
- aiAnswer는 그 derivedAnswer를 실제 선택지와 대조한 결과다.
- derivedAnswer를 aiAnswer에 맞추기 위해 바꾸지 않는다.
- 둘이 선택지상 서로 맞지 않으면 억지로 맞추지 말고 confident=false로 한다.

정답 검증 규칙:
- 학생 답을 정답이라고 가정하지 않는다.
- 문제를 직접 풀어서 판단한다.
- 객관식이면 계산 또는 추론 결과와 실제 선택지를 대조한다.
- 선택지 번호와 선택지 내용을 혼동하지 않는다.
- 단위와 조건을 확인한다.
- solution의 계산 및 추론은 derivedAnswer와 일치해야 한다.
- 확실하지 않으면 confident=false로 한다.

오답 분석 규칙:
- 학생의 풀이 과정은 제공되지 않았다.
- 학생이 어떤 계산이나 생각을 했는지 추측하지 않는다.
- 확인되지 않은 행동을 사실처럼 작성하지 않는다.
- 선택한 답만으로 원인을 확정할 수 없으면
  errorReason에 "풀이 과정이 없어 정확한 오답 원인은 확정할 수 없습니다."를 포함한다.
- errorDetail에는 다시 확인해야 할 핵심 지점만 작성한다.

errorType:
"개념 미숙", "계산 실수", "조건 해석 오류", "공식 적용 오류",
"문제 유형 미숙", "단순 실수", "문제 이해 부족"

difficulty:
"쉬움", "보통", "어려움"

유사문제 규칙:
- 핵심 개념은 원본과 같게 유지한다.
- 숫자, 조건, 상황은 적절히 변경한다.
- 각 유사문제는 생성한 뒤 직접 풀어 정답을 검산한다.
- 객관식이면 선택지를 모두 포함한다.
- 객관식 정답은 정확히 하나만 존재해야 한다.
- 객관식 similarAnswer는 실제 존재하는 선택지 번호와 내용을 함께 쓴다.
- 주관식이면 선택지를 만들지 않는다.
- 주관식 similarAnswer에는 선택지 번호를 붙이지 않는다.

짧게 출력:
- aiAnswer: 최종 선택지 번호 또는 최종 답만
- derivedAnswer: 풀이에서 얻은 최종 결과만
- errorReason: 핵심 오답 원인만 1문장
- unit: 교육과정 단원명만
- weakConcept: 핵심 개념을 짧은 구로
- weakConceptDetail: 부족한 부분만 1문장, concept와 같은 설명을 반복하지 않는다
- errorType: 지정된 분류 중 하나만
- errorDetail: 다시 확인할 핵심 지점만 1문장, errorReason을 반복하지 않는다
- problemType: 짧은 유형명만
- difficulty: 쉬움, 보통, 어려움 중 하나만
- concept: 풀이에 필요한 핵심 원리만 1문장, solution과 같은 내용을 반복하지 않는다
- solution: 정답 검증에 필요한 핵심 풀이만 작성한다. 계산 문제는 핵심 식과 최종 계산을 남기되 불필요한 문장 설명은 생략한다
- similarProblem: 원본과 같은 핵심 개념을 유지하되 문제를 푸는 데 필요한 조건만 포함한다
- similarAnswer: 최종 답 위주로 짧게 작성한다

중복 금지:
- errorReason, weakConceptDetail, errorDetail, concept, solution에 같은 설명을 반복하지 않는다.
- 한 필드에서 이미 설명한 내용을 다른 필드에서 다시 풀어쓰지 않는다.
- 정확한 정답 검증에 필요한 계산식, 조건, 근거는 생략하지 않는다.

반드시 JSON 객체 하나만 출력한다.

사진 문제 규칙:
- 문제 이미지가 제공되면 이미지 자체를 문제 원본으로 사용한다.
- 이미지 속 문제 본문, 수식, 조건, 표, 그래프, 도형, 회로도, 선택지를 직접 읽는다.
- imageScopeValid는 현재 보이는 일부 내용만으로 정답을 추론할 수 있는지를 뜻하지 않는다.
- imageScopeValid는 문제를 완전하고 안전하게 분석하는 데 필요한 전체 범위가 이미지 안에 들어 있는지를 뜻한다.
- 문제의 질문이나 발문이 잘렸거나 시작 부분이 보이지 않으면 imageScopeValid=false이다.
- 문제 해결에 필요한 제시문, 자료, 표, 그래프, 그림, 도형, 회로도, 수식 중 일부라도 잘렸으면 imageScopeValid=false이다.
- 객관식 문제라면 필요한 모든 선택지가 처음부터 끝까지 완전히 보여야 한다. 선택지 일부가 이미지 밖으로 잘렸으면 imageScopeValid=false이다.
- 이미지 가장자리에서 문장, 보기, 선택지, 표 등이 잘려 이어지는 것이 보이면 imageScopeValid=false이다.
- 서로 관련 없는 문제가 2개 이상 포함되어 어떤 문제를 풀어야 하는지 명확하지 않으면 imageScopeValid=false이다.
- 불확실한 글자나 숫자를 임의로 추측해서 채우지 않는다.
- 이미지에 남아 있는 정보나 외부 지식만으로 잘린 내용을 추론하여 정답을 알 수 있더라도 imageScopeValid=false이다.
- 범위가 완전한지 확신하기 어렵다면 false를 우선한다.
- imageScopeValid=false이면 정답을 억지로 추론하지 말고 confident=false로 반환한다.
- 문제 전체가 충분히 보이고 정상적으로 하나의 문제를 읽을 수 있을 때만 imageScopeValid=true로 반환한다.

{
  "aiAnswer": "",
  "derivedAnswer": "",
  "confident": true,
  "imageScopeValid": true,
  "errorReason": "",
  "unit": "",
  "weakConcept": "",
  "weakConceptDetail": "",
  "errorType": "",
  "errorDetail": "",
  "problemType": "",
  "difficulty": "",
  "concept": "",
  "solution": "",
  ${similarJson}
}
`.trim();

    let response;

    for (
        let attempt = 1;
        attempt <= 3;
        attempt++
    ) {
        response = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
            {
                signal:
                    AbortSignal.timeout(30000),

                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json",

                    "x-goog-api-key":
                        geminiApiKey
                },

                body: JSON.stringify({
                    contents: [
                        {
                            role: "user",

                            parts: [
    {
        text:
            hasProblemImage
                ? `${prompt}

[사진 문제 추가 규칙]
- 첨부된 이미지가 실제 문제 원본이다.
- 이미지의 문제 본문, 수식, 표, 그래프, 보기와 선택지를 직접 읽어라.
- 이미지에 있는 내용을 임의로 생략하거나 바꾸지 않는다.
- 이미지가 객관식이면 실제 선택지를 확인한 뒤 aiAnswer에는 선택지 번호만 작성한다.
- 이미지가 주관식이면 aiAnswer에는 최종 답만 작성한다.
- 문제 일부가 잘렸거나 수식·조건·선택지를 충분히 읽을 수 없으면 confident=false로 한다.
- 읽을 수 없는 부분을 추측해서 채우지 않는다.`
                : prompt
    },

    ...(hasProblemImage
        ? [
            {
                inlineData: {
                    mimeType:
                        problemImageContentType ||
                        "image/webp",

                    data:
                        String(
                            problemImageBase64
                        ).replace(
                            /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
                            ""
                        )
                }
            }
        ]
        : [])
]
                        }
                    ],

                    generationConfig: {
                        responseMimeType:
                            "application/json",

                        // 아직 7번 토큰 최적화 전
                        maxOutputTokens: 2200,

                        thinkingConfig: {
                            thinkingLevel: "low"
                        }
                    }
                })
            }
        );

        if (
            response.status !== 503 ||
            attempt === 3
        ) {
            break;
        }

        console.log(
            `GEMINI 503 - 자동 재시도 ${attempt}/2`
        );

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    attempt * 1000
                )
        );
    }

       const data =
        await response.json();

    // =====================================
    // ScorePath 21-156
    // Gemini 실제 토큰 사용량 기록
    // =====================================

    recordScorePathAiUsageV01({
        provider: "gemini",

        model: "gemini-3.1-flash-lite",

        purpose: "problem_analysis",

        httpOk: response.ok,

        usage: data?.usageMetadata
    });

    if (!response.ok) {
        console.error(
            "GEMINI ANSWER ERROR:",
            data
        );

        throw new Error(
            data?.error?.message ||
            "Gemini 정답 분석 요청 실패"
        );
    }

    const finishReason =
        data?.candidates?.[0]
            ?.finishReason;

    const content =
        data?.candidates?.[0]
            ?.content?.parts
            ?.map(
                part =>
                    part.text || ""
            )
            .join("")
            .trim();

    console.log(
        "GEMINI ANSWER FINISH:",
        finishReason
    );

    console.log(
        "GEMINI ANSWER RAW:",
        content
    );

    if (!content) {
        throw new Error(
            "Gemini 정답 분석 응답이 없습니다."
        );
    }

    const parsed =
        safeParseAiJson(
            content,
            "Gemini 정답 분석"
        );

    const aiAnswer =
        canonicalizeAiAnswer(
            parsed.aiAnswer,
            problem
        );

    if (!aiAnswer) {
        console.error(
            "GEMINI INVALID ANSWER:",
            {
                rawAnswer:
                    parsed.aiAnswer,

                problem
            }
        );

        throw new Error(
            "Gemini가 유효한 정답을 반환하지 않았습니다."
        );
    }

    const derivedAnswer =
        safeText(
            parsed.derivedAnswer
        );

    const solution =
        safeText(
            parsed.solution
        );

    /*
     * 기존 자연어 solutionConflict는
     * 진단 로그용으로 유지.
     */
    const solutionConflict =
        detectSolutionChoiceConflict(
            solution,
            aiAnswer,
            problem
        );

    /*
     * 새 구조화 결과 검사.
     *
     * 추가 AI 호출 없이 서버에서 실행된다.
     */
    const derivedCheck =
        checkDerivedAnswerConsistency(
            aiAnswer,
            derivedAnswer,
            problem
        );

    console.log(
        "GEMINI ANSWER VALIDATION:",
        {
            rawAnswer:
                parsed.aiAnswer,

            aiAnswer,

            derivedAnswer,

            derivedChecked:
                derivedCheck.checked,

            derivedChoice:
                derivedCheck.derivedChoice,

            derivedConflict:
                derivedCheck.conflict,

            confident:
                parsed.confident === true,

            solutionConflict
        }
    );


    
    return {
    imageScopeValid:
        hasProblemImage
            ? parsed.imageScopeValid === true
            : true,

    aiAnswer,

        derivedAnswer,

        derivedChecked:
            derivedCheck.checked,

        derivedChoice:
            derivedCheck.derivedChoice,

        derivedConflict:
            derivedCheck.conflict,

        confident:
            parsed.confident === true,

        solutionConflict,

        errorReason:
            safeText(
                parsed.errorReason
            ),

        unit:
            safeText(
                parsed.unit
            ),

        weakConcept:
            safeText(
                parsed.weakConcept
            ),

        weakConceptDetail:
            safeText(
                parsed.weakConceptDetail
            ),

        errorType:
            safeText(
                parsed.errorType
            ),

        errorDetail:
            safeText(
                parsed.errorDetail
            ),

        problemType:
            safeText(
                parsed.problemType
            ),

        difficulty:
            safeText(
                parsed.difficulty
            ),

        concept:
            safeText(
                parsed.concept
            ),

        solution,

        similarProblem1:
            safeText(
                parsed.similarProblem1
            ),

        similarAnswer1:
            safeText(
                parsed.similarAnswer1
            ),

        similarProblem2:
            safeText(
                parsed.similarProblem2
            ),

        similarAnswer2:
            safeText(
                parsed.similarAnswer2
            ),

        similarProblem3:
            safeText(
                parsed.similarProblem3
            ),

        similarAnswer3:
            safeText(
                parsed.similarAnswer3
            )
    };
}

async function verifySimilarAnswerWithGemini(problem) {
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!geminiApiKey) {
        throw new Error("GEMINI_API_KEY가 없습니다.");
    }

    const prompt = `
너는 문제의 정답을 독립적으로 검증하는 AI다.

[문제]
${problem}

규칙:
- 문제를 처음부터 직접 풀어라.
- 기존에 생성된 정답은 제공되지 않는다.
- 계산, 조건, 경계값, 단위를 확인한다.
- 객관식이면 실제 정답 선택지 내용을 answer에 작성한다.
- 정답을 충분히 확정할 수 있을 때만 confident=true로 한다.
- 풀이 설명은 출력하지 않는다.
- 반드시 JSON만 출력한다.

{
  "answer": "",
  "confident": false
}
`;

    const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
        {
            signal: AbortSignal.timeout(30000),
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": geminiApiKey
            },
            body: JSON.stringify({
                contents: [
                    {
                        role: "user",
                        parts: [{ text: prompt }]
                    }
                ],
                generationConfig: {
                    responseMimeType: "application/json",
                    maxOutputTokens: 300,
                    thinkingConfig: {
                        thinkingLevel: "low"
                    }
                }
            })
        }
    );

    const data = await response.json();

    // =====================================
    // ScorePath 21-160
    // 유사문제 정답 검증 토큰 기록
    // =====================================

    recordScorePathAiUsageV01({

        provider: "gemini",

        model: "gemini-3.1-flash-lite",

        purpose: "similar_answer_verification",

        httpOk: response.ok,

        usage: data?.usageMetadata

    });

    if (!response.ok) {
        throw new Error(
            data?.error?.message ||
            "유사문제 정답 검증 요청 실패"
        );
    }

    const content =
        data?.candidates?.[0]?.content?.parts
            ?.map(part => part.text || "")
            .join("")
            .trim();

    if (!content) {
        throw new Error("유사문제 정답 검증 응답이 없습니다.");
    }

    const parsed = JSON.parse(content);

    return {
        answer: safeText(parsed.answer),
        confident: parsed.confident === true
    };
}

async function requestOpenAIAnswerReview(
    problem,
    apiKey,
    problemImageBase64 = "",
    problemImageContentType = ""
) {
    const hasProblemImage =
        Boolean(
            safeText(
                problemImageBase64
            )
        );

    const imageDataUrl =
        hasProblemImage
            ? String(
                problemImageBase64
            ).startsWith("data:")
                ? String(
                    problemImageBase64
                )
                : `data:${
                    problemImageContentType ||
                    "image/webp"
                };base64,${
                    problemImageBase64
                }`
            : "";

    const userText = `
[문제]
${problem || (
    hasProblemImage
        ? "첨부된 문제 이미지를 직접 읽어라."
        : ""
)}

독립적으로 풀고 최종 정답만 반환해라.
`.trim();

    const userContent =
        hasProblemImage
            ? [
                {
                    type: "text",
                    text: userText
                },
                {
                    type: "image_url",
                    image_url: {
                        url:
                            imageDataUrl,
                        detail: "high"
                    }
                }
            ]
            : userText;

    const response =
        await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
                method: "POST",

                headers: {
                    "Authorization":
                        `Bearer ${apiKey}`,

                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    model:
                        "gpt-6-luna",

                    reasoning_effort:

                        "medium",

                    response_format: {
                        type:
                            "json_object"
                    },

                    messages: [
                        {
                            role:
                                "system",

                            content: `
너는 시험 문제의 정답을 독립적으로 검증한다.

문제만 보고 처음부터 직접 풀어라.
다른 AI의 답이나 사용자가 입력한 정답은 제공되지 않는다.

규칙:
- 문제의 조건, 정의, 공식, 단위를 정확히 적용한다.
- 계산 문제는 직접 계산하고 검산한다.
- 이미지가 제공되면 이미지 속 문제와 선택지를 직접 읽는다.
- 객관식은 실제 선택지와 결과를 대조한다.
- 객관식 reviewAnswer에는 선택지 번호만 작성한다.
- 숫자 단답형은 최종 숫자만 작성한다.
- 그 외 단답형은 최종 답만 작성한다.
- 확실하지 않으면 confident=false로 한다.
- 설명은 출력하지 않는다.
- JSON 객체 하나만 출력한다.

{"reviewAnswer":"","confident":false}
`.trim()
                        },

                        {
                            role:
                                "user",

                            content:
                                userContent
                        }
                    ],

                    max_completion_tokens:
                        3500
                })
            }
        );

    const data =
        await response.json();

    const finishReason =
        data?.choices?.[0]
            ?.finish_reason;

    console.log(
        "REVIEW FINISH:",
        finishReason
    );

    // =====================================
    // ScorePath 21-157
    // GPT 독립 검산 토큰 사용량 기록
    // =====================================

    recordScorePathAiUsageV01({
        provider: "openai",

        model: "gpt-6-luna",

        purpose: "answer_review",

        httpOk: response.ok,

        usage: data?.usage
    });

    if (!response.ok) {
        console.error(
            "REVIEW API ERROR:",
            data
        );

        return {
            reviewAnswer: "",
            confident: false,
            failed: true,
            failureReason:
                "api_error",
            finishReason
        };
    }

    const content =
        data?.choices?.[0]
            ?.message?.content
            ?.trim();

    if (!content) {
        console.warn(
            "ANSWER REVIEW EMPTY:",
            {
                finishReason,
                usage:
                    data?.usage
            }
        );

        return {
            reviewAnswer: "",
            confident: false,
            failed: true,

            failureReason:
                finishReason ===
                "length"
                    ? "length"
                    : "empty",

            finishReason
        };
    }

    let parsed;

    try {
        parsed =
            safeParseAiJson(
                content,
                "GPT 정답 검산"
            );

    } catch (error) {
        console.warn(
            "ANSWER REVIEW JSON FAILED:",
            error.message
        );

        return {
            reviewAnswer: "",
            confident: false,
            failed: true,
            failureReason:
                "json_parse",
            finishReason
        };
    }

    const reviewAnswer =
        canonicalizeAiAnswer(
            parsed.reviewAnswer,
            problem
        );

    if (!reviewAnswer) {
        return {
            reviewAnswer: "",
            confident: false,
            failed: true,
            failureReason:
                "invalid_answer",
            finishReason
        };
    }

    return {
        reviewAnswer,

        confident:
            parsed.confident ===
            true,

        failed: false,

        finishReason
    };
}

async function requestGeminiAnalyze({
    subject,
    problem,
    userAnswer,
    correctAnswer,
    plan
}) {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        throw new Error("GEMINI_API_KEY가 없습니다.");
    }

    const similarCount =
        plan === "free" ? 1 :
        plan === "premium5900" ? 2 :
        3;

const similarJson =
    similarCount === 1
        ? `"similarProblem1": "",
"similarAnswer1": ""`
        : similarCount === 2
        ? `"similarProblem1": "",
"similarAnswer1": "",
"similarProblem2": "",
"similarAnswer2": ""`
        : `"similarProblem1": "",
"similarAnswer1": "",
"similarProblem2": "",
"similarAnswer2": "",
"similarProblem3": "",
"similarAnswer3": ""`;

    const prompt = `
너는 학생용 오답 분석 AI다.

과목: ${subject}
문제:
${problem}

학생 답: ${userAnswer}
확인된 정답: ${correctAnswer}

다음 작업을 수행해라.

1. 학생 답과 확인된 정답을 비교하고, 학생이 왜 틀렸는지 구체적으로 분석한다.
2. 이 문제에서 학생에게 부족했을 가능성이 가장 높은 핵심 개념을 찾는다.
3. 오답 원인을 다음 중 가장 적절한 하나로 분류한다.
   - 개념 미숙
   - 계산 실수
   - 조건 해석 오류
   - 공식 적용 오류
   - 문제 유형 미숙
   - 단순 실수
   - 문제 이해 부족
4. 문제 유형을 구체적으로 분류한다.
5. 이 문제를 푸는 데 필요한 핵심 개념을 설명한다.
6. 확인된 정답을 기준으로 정확한 풀이를 작성한다.
7. 원본 문제와 개념은 같지만 숫자, 조건, 상황을 적절히 바꾼 유사문제를 ${similarCount}개 만든다.
8. 각 유사문제의 정답을 직접 다시 계산하여 정확하게 작성한다.
9. 원본 문제를 그대로 복사하거나 이름만 바꾸지 않는다.

반드시 JSON만 출력한다.

형식:
{
  "errorReason": "학생이 틀린 구체적인 이유",
  "weakConcept": "학생에게 부족한 개념",
  "errorType": "오답 원인 분류",
  "problemType": "구체적인 문제 유형",
  "concept": "핵심 개념",
  "solution": "풀이",
  ${similarJson}
}
`;

    const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
    {
        signal: AbortSignal.timeout(30000),
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey
            },
            body: JSON.stringify({
                contents: [
                    {
                        role: "user",
                        parts: [{ text: prompt }]
                    }
                ],
                generationConfig: {
                    responseMimeType: "application/json",
                    maxOutputTokens: 2500,
                    thinkingConfig: {
                        thinkingLevel: "low"
                    }
                }
            })
        }
    );

    const data = await response.json();

    if (!response.ok) {
        console.error("GEMINI API ERROR:", data);
        throw new Error(
            data?.error?.message || "Gemini API 요청 실패"
        );
    }

    console.log("GEMINI USAGE:", data.usageMetadata);

    const raw =
        data?.candidates?.[0]?.content?.parts
            ?.map(part => part.text || "")
            .join("")
            .trim();

    console.log("GEMINI RAW:", raw);

    if (!raw) {
        throw new Error("Gemini 응답 내용이 없습니다.");
    }

    const parsed = JSON.parse(raw);

    console.log("GEMINI PARSED:", parsed);

    return parsed;
}

async function requestLegacyOpenAIAnalyze(
    problem,
    userAnswer,
    correctAnswer,
    plan,
    apiKey,
    problemImageBase64 = "",
    problemImageContentType = ""
) {
    aiStats.total += 1;

    const choiceMap =
        getChoiceMap(problem);

    const aiUserAnswer =
        choiceMap[safeText(userAnswer)] ||
        userAnswer;

    console.log(
        "AI USER ANSWER:",
        aiUserAnswer
    );

    const answerResult =
    await requestOpenAIAnswer(
        problem,
        aiUserAnswer,
        plan,
        apiKey,
        problemImageBase64,
        problemImageContentType
    );

    console.log(
        "ANSWER 1 RESULT:",
        answerResult
    );
if (
    problemImageBase64 &&
    answerResult.imageScopeValid !== true
) {
    console.warn(
        "PROBLEM IMAGE SCOPE INVALID:",
        {
            imageScopeValid:
                answerResult.imageScopeValid
        }
    );

    const error =
        new Error(
            "문제 이미지 범위를 다시 선택해주세요."
        );

    error.code =
        "INVALID_PROBLEM_IMAGE_SCOPE";

    throw error;
}
    const firstAnswer =
        canonicalizeAiAnswer(
            answerResult.aiAnswer,
            problem
        );

    const enteredCorrectAnswer =
        normalizeAnswer(
            correctAnswer
        );

    const answerMatchesEntered =
        Boolean(firstAnswer) &&
        Boolean(enteredCorrectAnswer) &&
        answersEquivalent(
            firstAnswer,
            correctAnswer,
            problem
        );

    /*
     * derivedAnswer를 서버가 실제 선택지로
     * 변환할 수 있었고 aiAnswer와 다르면
     * 내부 모순으로 판단한다.
     */
    const derivedConflict =
        answerResult.derivedChecked === true &&
        answerResult.derivedConflict === true;

    /*
     * Gemini 정상 통과 조건.
     *
     * confident만으로는 부족하고,
     * 구조화된 풀이 결과와 최종 선택지 사이에
     * 확인된 모순이 없어야 한다.
     */
    const geminiUsable =
    Boolean(firstAnswer) &&
    answerResult.confident === true &&
    !derivedConflict &&
    answerResult.solutionConflict !== true;

    console.log(
        "ANSWER VALIDATION:",
        {
            aiAnswer:
                firstAnswer,

            derivedAnswer:
                answerResult.derivedAnswer,

            derivedChecked:
                answerResult.derivedChecked,

            derivedChoice:
                answerResult.derivedChoice,

            derivedConflict,

            enteredCorrectAnswer:
                correctAnswer,

            confident:
                answerResult.confident,

            solutionConflict:
                answerResult.solutionConflict,

            answerMatchesEntered,

            geminiUsable
        }
    );

    let verifiedAnswer = "";

/*
 * Gemini가 스스로 "어려움"으로 분류한 문제는
 * 내부 검사가 모두 정상이어도
 * GPT medium으로 한 번 더 독립 검증한다.
 *
 * 이유:
 * 어려운 문제에서는
 * solution / derivedAnswer / aiAnswer가
 * 서로 일관되게 같은 오답을 낼 수 있다.
 */
const highDifficulty =
    safeText(answerResult.difficulty)
        .trim() === "어려움";

/*
 * 가장 저렴한 정상 경로.
 *
 * 아래 조건을 모두 만족할 때만
 * Gemini-only로 확정한다.
 *
 * 1. Gemini 결과 사용 가능
 * 2. Gemini 정답 = 입력 정답
 * 3. 어려운 문제 아님
 */
if (
    geminiUsable &&
    answerMatchesEntered &&
    !highDifficulty
) {
    verifiedAnswer =
        firstAnswer;

    console.log(
        "ANSWER VERIFIED BY GEMINI + ENTERED:",
        verifiedAnswer
    );
} else {
        aiStats.mediumUsed += 1;

        console.log(
            "ANSWER NEEDS MEDIUM REVIEW:",
            {
                aiAnswer:
                    firstAnswer,

                derivedAnswer:
                    answerResult.derivedAnswer,

                derivedChoice:
                    answerResult.derivedChoice,

                derivedConflict,

                enteredCorrectAnswer:
                    correctAnswer,

                confident:
                    answerResult.confident,

                answerMatchesEntered,

                highDifficulty,

                geminiUsable
            }
        );

console.log(
    "GPT MEDIUM REVIEW INPUT:",
    {
        hasTextProblem:
            Boolean(
                safeText(problem)
            ),

        hasProblemImage:
            Boolean(
                safeText(
                    problemImageBase64
                )
            ),

        problemImageContentType:
            safeText(
                problemImageContentType
            )
    }
);

        const reviewResult =
    await requestOpenAIAnswerReview(
        problem,
        apiKey,
        problemImageBase64,
        problemImageContentType
    );

        console.log(
            "ANSWER REVIEW RESULT:",
            reviewResult
        );

        /*
         * GPT를 호출할 정도의 충돌이 있었는데
         * GPT마저 실패했다면
         * Gemini를 자동 채택하지 않는다.
         */
        if (
            reviewResult.failed ||
            !reviewResult.confident ||
            !reviewResult.reviewAnswer
        ) {
            console.warn(
                "ANSWER REVIEW FAILED - UNCERTAIN:",
                {
                    geminiAnswer:
                        firstAnswer,

                    derivedAnswer:
                        answerResult
                            .derivedAnswer,

                    derivedChoice:
                        answerResult
                            .derivedChoice,

                    derivedConflict,

                    enteredCorrectAnswer:
                        correctAnswer,

                    reviewFailure:
                        reviewResult
                            .failureReason,

                    finishReason:
                        reviewResult
                            .finishReason
                }
            );

            const reviewError = new Error(
    "2차 medium AI도 문제의 정답을 확정하지 못했습니다."
);

reviewError.code =
    "ANSWER_REVIEW_UNCERTAIN";

reviewError.reviewFailure =
    reviewResult.failureReason || "";

reviewError.finishReason =
    reviewResult.finishReason || "";

throw reviewError;
        }

        const reviewAnswer =
            canonicalizeAiAnswer(
                reviewResult.reviewAnswer,
                problem
            );

        if (!reviewAnswer) {
            console.warn(
                "ANSWER REVIEW INVALID - UNCERTAIN:",
                {
                    rawReviewAnswer:
                        reviewResult
                            .reviewAnswer
                }
            );

            throw new Error(
                "2차 medium AI가 유효한 정답을 반환하지 못했습니다."
            );
        }

        const reviewMatchesGemini =
            Boolean(firstAnswer) &&
            answersEquivalent(
                reviewAnswer,
                firstAnswer,
                problem
            );

        const reviewMatchesEntered =
            Boolean(
                enteredCorrectAnswer
            ) &&
            answersEquivalent(
                reviewAnswer,
                correctAnswer,
                problem
            );

        const reviewMatchesDerived =
            Boolean(
                answerResult
                    .derivedChoice
            ) &&
            answersEquivalent(
                reviewAnswer,
                answerResult
                    .derivedChoice,
                problem
            );

        console.log(
            "REVIEW CROSS CHECK:",
            {
                geminiAnswer:
                    firstAnswer,

                derivedAnswer:
                    answerResult
                        .derivedAnswer,

                derivedChoice:
                    answerResult
                        .derivedChoice,

                reviewAnswer,

                enteredCorrectAnswer:
                    correctAnswer,

                reviewMatchesGemini,
                reviewMatchesDerived,
                reviewMatchesEntered
            }
        );

        /*
         * 가장 강한 경우:
         * GPT가 Gemini 풀이에서 도출된
         * derivedChoice와 일치한다.
         *
         * 예:
         * Gemini aiAnswer = 4
         * derivedChoice = 2
         * GPT = 2
         *
         * → 2 채택
         */
        if (
            reviewMatchesDerived &&
            !reviewMatchesGemini
        ) {
            verifiedAnswer =
                reviewAnswer;

            console.warn(
                "GEMINI FINAL CHOICE REJECTED BY DERIVED + REVIEW:",
                {
                    geminiAnswer:
                        firstAnswer,

                    derivedChoice:
                        answerResult
                            .derivedChoice,

                    verifiedAnswer
                }
            );

        /*
         * GPT + Gemini 최종답 일치.
         *
         * derivedConflict가 있었더라도
         * 독립 GPT가 Gemini 최종답을
         * 다시 지지한 경우.
         */
        } else if (
            reviewMatchesGemini
        ) {
            verifiedAnswer =
                reviewAnswer;

            if (
                derivedConflict
            ) {
                console.warn(
                    "DERIVED RESULT REJECTED BY GEMINI + REVIEW:",
                    {
                        derivedChoice:
                            answerResult
                                .derivedChoice,

                        verifiedAnswer
                    }
                );
            }

            if (
                !reviewMatchesEntered
            ) {
                console.warn(
                    "ENTERED ANSWER MAY BE WRONG:",
                    {
                        enteredCorrectAnswer:
                            correctAnswer,

                        aiVerifiedAnswer:
                            verifiedAnswer
                    }
                );
            } else {
                console.log(
                    "ANSWER VERIFIED BY GEMINI + REVIEW:",
                    verifiedAnswer
                );
            }

        /*
         * GPT + 입력 정답 일치.
         *
         * Gemini 최종답만 다른 경우.
         */
        } else if (
            reviewMatchesEntered
        ) {
            verifiedAnswer =
                reviewAnswer;

            console.warn(
                "GEMINI ANSWER REJECTED BY REVIEW + ENTERED:",
                {
                    geminiAnswer:
                        firstAnswer,

                    verifiedAnswer
                }
            );

        /*
         * 어느 쪽도 독립적으로 합의하지 못함.
         */
        } else {
            console.warn(
                "ANSWER CONFLICT - UNCERTAIN:",
                {
                    enteredCorrectAnswer:
                        correctAnswer,

                    geminiAnswer:
                        firstAnswer,

                    derivedChoice:
                        answerResult
                            .derivedChoice,

                    reviewAnswer
                }
            );

            throw new Error(
                "정답 검증 결과가 서로 달라 정답을 안전하게 확정할 수 없습니다."
            );
        }
    }

    console.log(
        "AI COST STATS:",
        {
            total:
                aiStats.total,

            mediumUsed:
                aiStats.mediumUsed,

            noneOnly:
                aiStats.total -
                aiStats.mediumUsed,

            mediumRate:
                aiStats.total > 0
                    ? (
                        (
                            aiStats.mediumUsed /
                            aiStats.total
                        ) * 100
                    ).toFixed(1) + "%"
                    : "0%"
        }
    );

    /*
     * 학생 답 자체가 검증 정답이면
     * 오답 분석을 만들 필요가 없다.
     */
    if (
        answersEquivalent(
            userAnswer,
            verifiedAnswer,
            problem
        )
    ) {
        const answerCheck =
            compareAnswers(
                verifiedAnswer,
                correctAnswer,
                problem
            );

        console.log(
            "USER ANSWER ALREADY CORRECT - SKIP ANALYZE:",
            {
                userAnswer,
                verifiedAnswer
            }
        );

        return {
            aiAnswer:
                verifiedAnswer,

            verification:
                answerCheck.verification,

            warning:
                answerCheck.warning,

            reason: "",

            unit:
                safeText(
                    answerResult.unit
                ),

            weakConcept: "",
            weakConceptDetail: "",
            errorType: "",
            errorDetail: "",

            problemType:
                safeText(
                    answerResult
                        .problemType
                ),

            difficulty:
                normalizeDifficulty(
                    answerResult
                        .difficulty
                ),

            concept:
                safeText(
                    answerResult.concept
                ),

            solution:
                safeText(
                    answerResult.solution
                ),

            similarProblems: [],
            similarAnswerPairs: []
        };
    }

    const parsed =
        answerResult;

    console.log(
        "AI parsed from first Gemini:",
        parsed
    );

    const similarCount =
        getPlanRule(plan)
            .similarCount;

    const similarAnswerPairs = [
        {
            problem:
                ensureCorrectChoice(
                    safeText(
                        parsed
                            .similarProblem1
                    ),

                    safeText(
                        parsed
                            .similarAnswer1
                    )
                ),

            correctAnswer:
                safeText(
                    parsed
                        .similarAnswer1
                )
        },

        {
            problem:
                ensureCorrectChoice(
                    safeText(
                        parsed
                            .similarProblem2
                    ),

                    safeText(
                        parsed
                            .similarAnswer2
                    )
                ),

            correctAnswer:
                safeText(
                    parsed
                        .similarAnswer2
                )
        },

        {
            problem:
                ensureCorrectChoice(
                    safeText(
                        parsed
                            .similarProblem3
                    ),

                    safeText(
                        parsed
                            .similarAnswer3
                    )
                ),

            correctAnswer:
                safeText(
                    parsed
                        .similarAnswer3
                )
        }
    ]
        .filter(
            item =>
                item.problem &&
                item.correctAnswer
        )
        .slice(
            0,
            similarCount
        );

    const similarProblems =
        similarAnswerPairs.map(
            item =>
                item.problem
        );

    const answerCheck =
        compareAnswers(
            verifiedAnswer,
            correctAnswer,
            problem
        );

    return {
        aiAnswer:
            verifiedAnswer,

        verification:
            answerCheck.verification,

        warning:
            answerCheck.warning,

        reason:
            safeText(
                parsed.errorReason
            ) ||
            sanitizeReason(
                userAnswer,
                verifiedAnswer
            ),

        unit:
            safeText(
                parsed.unit
            ),

        weakConcept:
            safeText(
                parsed.weakConcept
            ),

        weakConceptDetail:
            safeText(
                parsed
                    .weakConceptDetail
            ),

        errorType:
            normalizeErrorType(
                parsed.errorType
            ),

        errorDetail:
            safeText(
                parsed.errorDetail
            ),

        problemType:
            safeText(
                parsed.problemType
            ),

        difficulty:
            normalizeDifficulty(
                parsed.difficulty
            ),

        concept:
            safeText(
                parsed.concept
            ) ||
            "개념 설명이 없습니다.",

        solution:
            safeText(
                parsed.solution
            ) ||
            "해결 방법이 없습니다.",

        similarProblems,
        similarAnswerPairs
    };
}

// =====================================
// ScorePath 21-393
// B 방식: 검증된 템플릿 + 정답 선계산
// =====================================

function buildVerifiedSimilarV01(parsed, originalProblem, count) {

    const topic = [
        originalProblem,
        parsed.problemType,
        parsed.concept,
        parsed.weakConcept,
        parsed.solution
    ].map(safeText).join(" ");

    // =====================================
    // 1. 주사위 + 카드 뒤집기 확률
    // =====================================

    if (
        /카드/.test(topic) &&
        /뒤집/.test(topic) &&
        /주사위/.test(topic) &&
        /확률|경우의 수/.test(topic)
    ) {

        const templates = [
            {
                rounds: 4,
                backs: [1, 2, 3, 4, 5, 6],
                different: false
            },
            {
                rounds: 4,
                backs: [2, 3],
                different: true
            },
            {
                rounds: 5,
                backs: [1, 2, 3],
                different: false
            },
            {
                rounds: 5,
                backs: [2, 3, 6],
                different: true
            },
            {
                rounds: 4,
                backs: [1, 6],
                different: true
            },
            {
                rounds: 5,
                backs: [1],
                different: false
            }
        ];

        // 호출마다 다른 템플릿 선택
        const offset =
            Math.floor(Math.random() * templates.length);

        const selected = Array.from(
            {
                length: Math.min(
                    count,
                    templates.length
                )
            },
            (_, i) =>
                templates[
                    (offset + i) % templates.length
                ]
        );

        return selected.map(
            ({ rounds, backs, different }) => {

                // 최초 뒷면 카드 상태
                const target = backs.reduce(
                    (mask, card) =>
                        mask | (1 << (card - 1)),
                    0
                );

                const sequences = 6 ** rounds;

                let total = 0;
                let favorable = 0;

                // 가능한 주사위 결과를 전부 계산
                for (
                    let sequence = 0;
                    sequence < sequences;
                    sequence++
                ) {

                    let remaining = sequence;
                    let flipped = 0;

                    let first = 0;
                    let second = 0;

                    for (
                        let t = 0;
                        t < rounds;
                        t++
                    ) {

                        const k =
                            (remaining % 6) + 1;

                        remaining =
                            Math.floor(remaining / 6);

                        if (t === 0) first = k;
                        if (t === 1) second = k;

                        for (
                            let card = 1;
                            card <= 6;
                            card++
                        ) {

                            const shouldFlip =
                                k % 2
                                    ? card <= k
                                    : card >= k;

                            if (shouldFlip) {
                                flipped ^=
                                    1 << (card - 1);
                            }
                        }
                    }

                    // 첫 번째와 두 번째 눈이
                    // 서로 다른 조건 확인
                    if (
                        different &&
                        first === second
                    ) {
                        continue;
                    }

                    total++;

                    // 최종 모두 앞면 조건
                    if (flipped === target) {
                        favorable++;
                    }
                }

                // 최대공약수로 기약분수 계산
                let a = favorable;
                let b = total;

                while (b) {
                    [a, b] = [b, a % b];
                }

                const answer =
                    favorable === 0
                        ? "0"
                        : `${
                            favorable / a
                        }/${
                            total / a
                        }`;

                const initial =
                    backs.length === 6
                        ? "모두 뒷면"
                        : `${
                            backs.join(", ")
                        }번 카드만 뒷면이고 나머지는 앞면`;

                // 정답 계산이 끝난 뒤 문제 구성
                const question =
                    `1부터 6까지 적힌 카드 6장이 ` +
                    `처음에는 ${initial}이다. ` +

                    `공정한 주사위를 던져 나온 눈을 k라 할 때, ` +

                    `k가 홀수면 번호가 k 이하인 카드를 ` +
                    `모두 한 번씩 뒤집고, ` +

                    `k가 짝수면 번호가 k 이상인 카드를 ` +
                    `모두 한 번씩 뒤집는다. ` +

                    `이 시행을 독립적으로 ${rounds}회 반복한다. ` +

                    (
                        different
                            ? `첫 번째와 두 번째 시행의 ` +
                              `주사위 눈이 서로 다르다는 조건에서, `
                            : ""
                    ) +

                    `모든 카드가 앞면일 확률을 구하시오.`;

                return {
                    problem: question,
                    correctAnswer: answer
                };
            }
        );
    }

    // =====================================
    // 2. 한국사 검증된 문제 템플릿
    // =====================================

    if (
        /국가총동원법|국민징용령|황국 신민|전시 동원/.test(topic) &&
        /일제|강점기|총동원|징용/.test(topic)
    ) {

        return [
            {
                problem:
                    "일제 강점기 전시 동원기에 " +
                    "학교에서 학생들에게 암송을 강요한 " +
                    "서사의 이름을 쓰시오.",

                correctAnswer:
                    "황국 신민 서사"
            },

            {
                problem:
                    "일제 강점기 전시 동원기에 " +
                    "강제로 동원된 조선인들이 일했던 " +
                    "대표적인 산업 시설 두 곳을 쓰시오.",

                correctAnswer:
                    "탄광과 군수 공장"
            }
        ].slice(0, count);
    }

    // 지원하지 않는 유형은 기존 방식 유지
    return null;
}


// =====================================
// ScorePath 21-375
// GPT-6 Luna Medium 단독 기본 분석
// Gemini 1차 분석 / GPT 2차 검증 없음
// =====================================

async function requestOpenAIAnalyze(
    problem,
    userAnswer,
    correctAnswer,
    plan,
    apiKey,
    problemImageBase64 = "",
    problemImageContentType = "",
    photoCount = 0
) {
    aiStats.total += 1;

    const similarCount = Math.min(
        3,
        Math.max(
            0,
            Number(getPlanRule(plan).similarCount || 0)
        )
    );

    const hasImage = Boolean(
        safeText(problemImageBase64)
    );

    const rawImage = String(
        problemImageBase64 || ""
    ).trim();

    const imageUrl = hasImage
        ? (
            rawImage.startsWith("data:")
                ? rawImage
                : `data:${
                    problemImageContentType || "image/webp"
                };base64,${rawImage}`
        )
        : "";

    // 입력 정답을 AI에 알려주지 않고
    // 문제를 독립적으로 풀도록 한다.

    const prompt = `
너는 ScorePath 학생용 오답 분석 AI다.

[문제]
${problem || "첨부된 사진을 직접 읽어라."}

[학생 답]
${userAnswer}

작업:
1. 문제를 처음부터 독립적으로 푼다.
2. 문제의 모든 조건과 수식을 확인한다.
3. 사진에 도형이나 그래프가 있으면 직접 해석한다.
4. 객관식이면 선택지를 직접 확인한다.
5. 정확한 정답과 풀이를 작성한다.
6. 학생의 오답 원인과 부족한 개념을 분석한다.
7. 원본의 풀이 순서와 조건 관계를 유지하며 조건 1~2곳만 변형한 유사문제 ${similarCount}개를 만든다.
8. 변형된 문제를 원본의 풀이 순서대로 다시 풀어 정답을 새로 계산한다.

정답 규칙:
- 객관식 aiAnswer에는 선택지 번호만 작성한다.
- 주관식 aiAnswer에는 최종 답만 작성한다.
- derivedAnswer에는 풀이에서 계산한 결과를 작성한다.
- solution, derivedAnswer, aiAnswer가 일치해야 한다.
- 확실하지 않다면 confident=false로 한다.

사진 규칙:
- 사진은 최대 세 장의 지문·그림·선택지를 하나로 묶은 이미지일 수 있다.
- 여러 구역은 오직 독립적인 문제 하나의 정보로만 연결되어야 한다.
- 서로 다른 독립 문제나 질문이 2개 이상 있으면 imageScopeValid=false, confident=false로 하고 풀이를 제공하지 않는다.
- 문제 안의 ㄱ·ㄴ·ㄷ, 객관식 보기, 하나의 문제에 속한 자료 여러 개는 정상적으로 허용한다.
- 사진 속 문제와 선택지를 직접 읽는다.
- 일부가 잘렸다면 imageScopeValid=false로 한다.
- 읽지 못한 조건을 추측하지 않는다.

오답 분석 및 출력 규칙:
- 정답의 정확성을 최우선으로 한다. 문제를 푸는 데 필요한 계산과 검토는 생략하지 않는다.
- solution은 핵심 풀이 2~4단계로 작성한다.
- 각 단계는 ① ② ③ 순서로 시작하고 줄바꿈으로 구분한다.
- 각 단계에는 짧은 설명과 필요한 수식만 포함한다.
- 복잡한 문제는 정답을 이해하는 데 필요한 중간 계산을 반드시 포함한다.
- 같은 계산이나 최종 정답을 반복해서 설명하지 않는다.
- 긴 문단, 인사말, 불필요한 부연 설명은 작성하지 않는다.
- weakConcept에는 핵심 개념명만 작성한다.
- weakConceptDetail에는 다음에 복습할 내용을 1문장으로 작성한다.
- errorReason과 errorDetail은 최대한 짧게 작성한다.
- 학생의 풀이가 없으면 틀린 이유를 추측하지 않는다.
- concept, unit, problemType, difficulty는 짧고 정확하게 작성한다.
- 유사문제의 정답에는 해설 없이 최종 답만 작성한다.

유사문제 규칙:
- 원본 문제의 풀이 단계 수, 필요한 공식, 조건 사이 관계를 유지한다.
- 숫자·변수·대상 등 조건 1~2곳만 바꿔 원본과 비슷한 난이도로 만든다.
- 원본에 없는 새로운 법칙·변수·극값 조건을 임의로 추가하지 않는다.
- 그림 없이 풀 수 없는 문제는 필요한 도형·그래프 조건을 정확히 문장으로 적는다.
- 원본에서 원리와 정답의 관계를 유지할 수 없으면 해당 문제와 정답을 빈 문자열로 둔다.

- 원본이 주사위 숫자에 따라 카드를 뒤집는 확률 문제이거나
  일제 강점기 전시 동원(국가총동원법 등) 문제라면
  similarProblem1~3과 similarAnswer1~3을 빈 문자열로 둔다.
  이 두 유형은 서버가 검증된 템플릿에서 정답을 먼저 계산해 제공한다.

- 다른 유형은 아래 기존 규칙에 따라 유사문제를 생성한다.

- 문제를 만들기 전에 성립하는 조건과 정답을 먼저 정하고,
  그 결과와 일치하도록 문제 문장을 구성한다.

- 생성한 뒤 문제에 제시한 모든 숫자, 식, 범위, 좌표,
  그래프 정보가 동시에 참인지 확인한다.

- 함수 문제는 구한 매개변수를 원래 함수식에 다시 대입해
  최댓값, 최솟값, 교점, 주기, 특정 점의 위치를 각각 검산한다.

- 특히 y=a sin(bx)+c 형태라면
  최댓값과 최솟값의 평균이 c인지,
  두 값의 차가 2|a|인지 확인한다.

- 제시된 봉우리의 x좌표를 함수식에 대입했을 때
  실제로 최댓값이 되는지도 확인한다.

- 원본이 그래프 문제라도 그림을 제공할 수 없다면
  필요한 정보를 모순 없는 문장이나 수치로 표현한다.

- 생성한 유사문제를 원본 정답과 무관하게 처음부터 직접 풀고,
  계산 결과와 similarAnswer가 일치하는지 확인한다.

- 조건이 충돌하거나 답이 여러 개라면
  조건을 수정한 후 다시 검산한다.

- 끝내 성립 여부를 확신할 수 없다면
  해당 similarProblem과 similarAnswer를 모두 빈 문자열로 반환한다.

- similarAnswer에는 풀이 없이 최종 정답만 쓴다.
- 정답 번호보다는 값이나 식으로 답하도록 출제한다.

- 기존 JSON 키를 유지하고 추가 AI 호출 없이
  한 번의 기본 분석 응답 안에서 처리한다.

최종 검산 체크리스트(출력 전에 내부적으로 수행):

- 원본의 계산값 derivedAnswer가 어떤 객관식 선택지에
  해당하는지 확인하고 aiAnswer에 그 선택지 번호를 쓴다.
  계산값 5와 ⑤번은 다른 의미일 수 있으니 혼동하지 않는다.

- solution, errorReason, errorDetail에 쓰인 정답 번호가
  aiAnswer와 전부 일치하는지 확인한다.
  원본 선택지 번호를 유사문제 정답으로 재사용하지 않는다.

- 유사문제마다 실제로 문제 조건이 동시에 성립하는지
  대입하여 검산한다.
  특히 함수의 극값·주기·봉우리 위치·정의역을 서로 대조한다.

- 각 유사문제를 원본 풀이와 무관하게 처음부터 풀어
  similarAnswer와 정확히 일치하는지 확인한다.
  확률은 경우의 수 총합과 성공 경우를 다시 계산한다.

- 바꾼 조건만으로 새 정답이 실제 성립하는지 원본 풀이 순서대로 계산한다.
- 원본과 다른 풀이법이 필요한 문제가 됐다면 원본 변형 문제로 인정하지 않는다.
- 난이도가 급변하거나 조건이 모순이면 해당 문제와 정답을 빈 문자열로 둔다.

- 유사문제 검산에 자신이 없으면 해당 similarProblem과
  similarAnswer를 모두 빈 문자열로 반환한다.
  잘못된 문제나 정답을 확신한 척 제공하지 않는다.

- similarAnswer에는 최종 값만 넣고,
  정답 번호나 풀이를 섞지 않는다.
  객관식 유사문제가 아닌 경우 번호 ①~⑤로 답하지 않는다.

반드시 다음 형식의 JSON 객체 하나만 출력한다.

{
  "aiAnswer": "",
  "derivedAnswer": "",
  "confident": false,
  "imageScopeValid": true,
  "errorReason": "",
  "unit": "",
  "weakConcept": "",
  "weakConceptDetail": "",
  "errorType": "",
  "errorDetail": "",
  "problemType": "",
  "difficulty": "",
  "concept": "",
  "solution": "",
  "similarProblem1": "",
  "similarAnswer1": "",
  "similarProblem2": "",
  "similarAnswer2": "",
  "similarProblem3": "",
  "similarAnswer3": ""
}
`.trim();

    const userContent = hasImage
        ? [
            {
                type: "text",
                text: prompt
            },
            {
                type: "image_url",
                image_url: {
                    url: imageUrl,
                    detail: "high"
                }
            }
        ]
        : prompt;

    // =====================================
    // GPT API 단독 1회 호출
    // =====================================

    const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
            method: "POST",

            signal: AbortSignal.timeout(120000),

            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                model: "gpt-6-luna",

                reasoning_effort: "medium",

                max_completion_tokens: 10000,

                response_format: {
                    type: "json_object"
                },

                messages: [
                    {
                        role: "system",
                        content:
                            "문제를 독립적으로 풀고 JSON 객체 하나만 출력한다."
                    },
                    {
                        role: "user",
                        content: userContent
                    }
                ]
            })
        }
    );

    const data = await response.json();

    // =====================================
    // 실제 AI 비용 기록
    // =====================================

    recordScorePathAiUsageV01({
        provider: "openai",

        model: "gpt-6-luna",

        purpose: "problem_analysis_single",
        imageCount: photoCount,

        httpOk: response.ok,

        usage: data?.usage
    });

    const finishReason =
        data?.choices?.[0]?.finish_reason || "";

    const raw = String(
        data?.choices?.[0]?.message?.content || ""
    ).trim();

    console.log(
        "GPT SINGLE FINISH:",
        finishReason
    );

    console.log(
        "GPT SINGLE MESSAGE:",
        raw
    );

    // =====================================
    // 응답 실패 처리
    // 추가 AI 호출은 하지 않음
    // =====================================

    if (
        !response.ok ||
        finishReason !== "stop" ||
        !raw
    ) {
        const error = new Error(
            data?.error?.message ||
            "GPT 단독 분석 결과가 불완전합니다."
        );

        error.code = "ANSWER_REVIEW_UNCERTAIN";

        error.reviewFailure = !response.ok
            ? "api_error"
            : finishReason === "length"
                ? "length"
                : "empty";

        error.finishReason = finishReason;

        throw error;
    }

    const parsed = safeParseAiJson(
        raw,
        "GPT 단독 분석"
    );

    // =====================================
    // 사진 범위 확인
    // =====================================

    if (
        hasImage &&
        parsed.imageScopeValid !== true
    ) {
        const error = new Error(
            "사진에서 문제 전체를 확인할 수 없습니다."
        );

        error.code =
            "INVALID_PROBLEM_IMAGE_SCOPE";

        throw error;
    }

    // =====================================
    // 정답 확인
    // =====================================

    const aiAnswer = canonicalizeAiAnswer(
        parsed.aiAnswer,
        problem
    );

    const derivedCheck =
        checkDerivedAnswerConsistency(
            aiAnswer,
            safeText(parsed.derivedAnswer),
            problem
        );

    if (
        !aiAnswer ||
        parsed.confident !== true ||
        derivedCheck.conflict === true
    ) {
        const error = new Error(
            "GPT가 정답을 확정하지 못했습니다."
        );

        error.code = "ANSWER_REVIEW_UNCERTAIN";

        error.reviewFailure = "uncertain";

        throw error;
    }

    console.log(
        "GPT SINGLE ANSWER:",
        {
            aiAnswer,
            enteredCorrectAnswer: correctAnswer,
            derivedAnswer: parsed.derivedAnswer
        }
    );

    const check = compareAnswers(
        aiAnswer,
        correctAnswer,
        problem
    );

    const studentCorrect =
        answersEquivalent(
            userAnswer,
            aiAnswer,
            problem
        );

    // =====================================
    // ScorePath 21-387
    // Luna 정답 번호 충돌 검사
    // =====================================

    const expectedChoice =
        normalizeAnswer(aiAnswer);

    const hasWrongChoiceInText = (value) => {

        if (!/^[1-9]$/.test(expectedChoice)) {
            return false;
        }

        const text = safeText(value);

        const matches = text.matchAll(
            /정답(?:은|이|:)?\s*([①②③④⑤⑥⑦⑧⑨]|[1-9]\s*번)/g
        );

        return [...matches].some(
            (match) =>
                normalizeAnswer(match[1]) !==
                expectedChoice
        );
    };

    // 풀이 자체에 다른 정답 번호가 있으면
    // 확정된 분석 결과로 제공하지 않는다.
    if (hasWrongChoiceInText(parsed.solution)) {

        const error = new Error(
            "AI 풀이에 표시된 정답 번호가 계산 결과와 다릅니다."
        );

        error.code =
            "ANSWER_REVIEW_UNCERTAIN";

        error.reviewFailure =
            "choice_conflict";

        throw error;
    }

    // 정답 안내 문구에만 번호 오류가 있으면
    // 잘못된 안내를 안전한 문구로 대체한다.
    for (
        const key of [
            "errorReason",
            "errorDetail"
        ]
    ) {

        if (hasWrongChoiceInText(parsed[key])) {

            console.warn(
                "LUNA ANSWER CHOICE TEXT CONFLICT:",
                key
            );

            parsed[key] =
                "AI 판단 정답은 " +
                aiAnswer +
                "입니다. 풀이 과정을 확인해 주세요.";
        }
    }

    // =====================================
    // 유사문제 정리
    // =====================================

     // =====================================
    // ScorePath 21-393
    // 검증된 유사문제 템플릿 우선 적용
    // =====================================

    const verifiedPairs = studentCorrect
        ? null
        : buildVerifiedSimilarV01(
            parsed,
            problem,
            similarCount
        );

    const pairs = studentCorrect
        ? []
        : verifiedPairs !== null
            ? verifiedPairs
            : [1, 2, 3]
                .slice(0, similarCount)
                .map(i => ({
                    problem: ensureCorrectChoice(
                        safeText(
                            parsed[`similarProblem${i}`]
                        ),
                        safeText(
                            parsed[`similarAnswer${i}`]
                        )
                    ),

                    correctAnswer: safeText(
                        parsed[`similarAnswer${i}`]
                    )
                }))
                .filter(item =>
                    item.problem &&
                    item.correctAnswer
                );

    // 어떤 방식으로 생성했는지 확인
    if (
        !studentCorrect &&
        verifiedPairs !== null
    ) {
        console.log(
            "SCOREPATH VERIFIED TEMPLATE:",
            {
                count: pairs.length,
                pairs
            }
        );
    }

    // =====================================
    // ScorePath 기존 결과 형식 유지
    // =====================================

    return {
        aiAnswer,

        verification: check.verification,

        warning: check.warning,

        reason: studentCorrect
            ? ""
            : safeText(parsed.errorReason),

        unit: safeText(parsed.unit),

        weakConcept: studentCorrect
            ? ""
            : safeText(parsed.weakConcept),

        weakConceptDetail: studentCorrect
            ? ""
            : safeText(parsed.weakConceptDetail),

        errorType: studentCorrect
            ? ""
            : normalizeErrorType(
                parsed.errorType
            ),

        errorDetail: studentCorrect
            ? ""
            : safeText(parsed.errorDetail),

        problemType: safeText(
            parsed.problemType
        ),

        difficulty: normalizeDifficulty(
            parsed.difficulty
        ),

        concept: safeText(
            parsed.concept
        ),

        solution: safeText(
            parsed.solution
        ),

        similarProblems: pairs.map(
            item => item.problem
        ),

        similarAnswerPairs: pairs
    };
}


// =====================================
// 기존 응용문제 생성 함수
// 변경하지 않음
// =====================================

async function requestOpenAIAdvanced(
    problem,
    apiKey,
    problemImageDataUrl = "",
    photoCount = 0
) {

    // 기존 응용문제 생성 프롬프트 유지
    const prompt = buildAdvancedPrompt(
        problem ||
        "원본 문제는 첨부된 사진에 있다. 사진의 문장, 수식, 도형, 선택지를 직접 읽어라."
    ) + "\n중요: 첨부 사진에는 한 문제에 속한 지문·그림·선택지만 있어야 한다. 서로 독립적인 문제가 여러 개면 원문 여러 문제를 결합하거나 전부 풀지 말고 JSON의 advancedProblem과 answer를 빈 문자열로 반환한다.";

    // 사진이 있으면 텍스트 + 사진을 함께 전달
    const userContent = problemImageDataUrl
        ? [
            {
                type: "text",
                text: prompt
            },
            {
                type: "image_url",
                image_url: {
                    url: problemImageDataUrl,
                    detail: "high"
                }
            }
        ]
        : prompt;

    const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
            method: "POST",

            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },

            body: JSON.stringify({

                model: "gpt-6.1-terra",

                reasoning_effort: "medium",

                messages: [
                    {
                        role: "system",
                        content:
                            "너는 학생용 응용문제 생성기다. 반드시 JSON만 출력한다."
                    },
                    {
                        role: "user",
                        content: userContent
                    }
                ],

                max_completion_tokens: 3000
            })
        }
    );

const data = await response.json();

console.log("ADVANCED FINISH:", data?.choices?.[0]?.finish_reason);
// =====================================
// ScorePath 21-161
// 응용문제 생성 GPT 토큰 기록
// =====================================

recordScorePathAiUsageV01({

    provider: "openai",

    model: "gpt-6.1-terra",

    purpose: "advanced_problem_generation",
    imageCount: photoCount,

    httpOk: response.ok,

    usage: data?.usage

});
console.log("ADVANCED MESSAGE:", data?.choices?.[0]?.message);

if (!response.ok) {
    throw new Error(JSON.stringify(data));
}

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error("빈 응답");
    }

    let parsed = {};
    try {
        parsed = JSON.parse(content);
    } catch {
        parsed = {};
    }

  return {
    advancedProblem:
        safeText(parsed.advancedProblem) ||
        makeFallbackAdvancedProblem(problem),

    answer: safeText(parsed.answer)
};

}

function buildAdvancedPrompt(problem) {
    return `
다음 원본 문제를 분석한 뒤, 같은 핵심 개념을 사용하는 응용문제 1개를 만들어라.

원본 문제:
${problem}

목표:
학생이 원본 문제의 답이나 풀이를 단순히 외운 것이 아니라,
핵심 개념을 새로운 조건이나 상황에서도 적용할 수 있는지 확인한다.

먼저 내부적으로 다음을 판단한다.
- 이 문제가 어떤 분야의 문제인지 파악한다.
- 문제 해결에 실제로 필요한 핵심 개념, 공식, 원리, 규칙을 파악한다.
- 원본 문제의 난이도와 문제 형식을 파악한다.
- 원본 문제를 직접 풀어 필요한 핵심 사고 단계를 확인한다.
- 학생이 답을 구하기 위해 몇 단계의 판단과 계산을
  수행해야 하는지 파악한다.
- 원본에서 그래프, 도형, 표, 지문, 선택지 등을
  해석해야 한다면 그 과정이 풀이에서 어떤 역할을
  하는지 파악한다.
- 계산 자체의 복잡함뿐 아니라 조건 해석,
  개념 적용, 추론의 어려움까지 고려한다.

응용문제 생성 규칙:

1. 반드시 원본 문제와 같은 핵심 개념을 사용한다.

2. 원본의 숫자, 이름, 단어만 바꾼 문제를 만들지 않는다.

3. 다음 중 최소 하나 이상을 의미 있게 변화시킨다.
- 주어진 조건
- 문제 상황
- 묻는 대상
- 정보가 제시되는 방식
- 풀이 순서
- 핵심 개념을 적용해야 하는 위치

4. 원본과 비슷한 난이도와 사고 수준을 유지한다.

- 원본의 핵심 개념과 필요한 사고 단계를 유지한다.
- 원본이 여러 조건을 종합해야 하는 문제라면
  응용문제도 여러 조건을 종합해야 풀리도록 만든다.
- 원본이 그래프나 자료를 해석해야 하는 문제라면
  응용문제에서도 그에 상응하는 자료 해석이 필요해야 한다.
- 원본이 복잡한 추론을 요구하는 문제라면
  단순 공식 대입이나 암기 문제로 바꾸지 않는다.
- 원본보다 약간 어렵게 만드는 것은 허용하지만
  새로운 단원의 핵심 개념까지 요구하지 않는다.
- 원본보다 현저히 쉬워지거나 어려워지는 것을 피한다.

5. 분야에 맞게 응용한다.
- 수학·과학·전기 등의 계산 문제:
  단순 수치 변경이 아니라 조건이나 구해야 하는 값을 바꾸는 것을 우선한다.
- 개념·이론·사회·역사·경제·회계 문제:
  같은 개념을 새로운 사례나 상황에 적용하도록 만든다.
- 프로그래밍 문제:
  같은 문법이나 실행 원리를 유지하면서 코드, 조건 또는 실행 흐름을 변형한다.
- 전문·자격증 문제:
  실제 해당 분야에서 사용되는 정의, 규칙, 공식과 현실적인 문제 형식을 유지한다.
- 언어 문제:
  같은 문법, 독해 원리 또는 판단 기준을 다른 문장이나 상황에 적용하게 한다.

6. 객관식 원문이라고 해서 반드시 객관식으로 만들 필요는 없다.
단, 객관식으로 만들 경우 선택지를 모두 작성한다.

7. 객관식 문제라면:
- 실제 정답이 선택지에 정확히 하나만 존재해야 한다.
- 정답과 같은 의미의 선택지가 두 개 이상 존재하면 안 된다.
- 오답 선택지도 문제와 관련 있는 자연스러운 선택지여야 한다.

8. 문제에 필요한 모든 정보는 문제 안에 포함한다.
외부 자료가 없으면 풀 수 없는 문제를 만들지 않는다.

9. 애매한 표현이나 여러 답이 가능한 조건을 만들지 않는다.

10. 생성한 응용문제를 원본 문제와 내부적으로 비교한다.

다음 기준을 확인한다.

- 핵심 개념이 동일한가?
- 원본과 비슷한 수준의 사고력이 필요한가?
- 핵심 판단이나 계산 단계가 지나치게 줄어들지 않았는가?
- 원본에서 중요했던 자료 해석 능력이 유지되는가?
- 새로운 개념 때문에 난이도가 불필요하게 높아지지 않았는가?
- 원본과 다른 조건을 활용하는 진정한 응용문제인가?

원본보다 현저히 쉽거나 어렵다고 판단되면
문제의 조건이나 질문을 수정한다.

원본의 그래프나 도형이 문제 해결에 필수적인 경우,
그림을 정확하게 제공할 수 없다면
필요한 정보를 명확한 문장이나 표로 제공한다.
단, 원본의 핵심적인 해석 과정을
단순 계산 문제로 축소하지 않는다.

11. 생성 후 반드시 응용문제를 직접 처음부터 풀어본다.

12. 계산 문제라면 식, 조건, 단위가 서로 맞는지 내부적으로 확인한다.

13. 개념 문제라면 정답이 해당 정의나 원리에 실제로 부합하는지 확인한다.

14. 객관식이라면 모든 선택지를 확인하여 정답이 정확히 하나인지 검산한다.

15. 처음 계산하거나 판단한 정답과 재검산한 정답이 다르면
문제를 수정하고 다시 검산한다.

16. 문제 자체에 오류가 있거나 정답을 하나로 확정할 수 없다면
조건이나 선택지를 수정하여 정상적으로 성립하는 문제를 만든다.

17. advancedProblem 안에는 정답, 풀이, 힌트 또는
정답을 직접 알 수 있는 설명을 넣지 않는다.

answer 규칙:
- 생성한 응용문제를 직접 풀어서 얻은 실제 최종 정답을 작성한다.
- 숫자 문제는 필요한 경우 단위를 포함한다.
- 객관식 문제는 정답 선택지의 실제 내용을 작성한다.
- "정답", "답", "answer" 같은 임시 문구를 넣지 않는다.
- 풀이 과정이나 설명은 answer에 넣지 않는다.

반드시 아래 JSON 객체 하나만 출력한다.
JSON 밖의 설명이나 다른 텍스트는 절대 출력하지 않는다.

{
  "advancedProblem": "",
  "answer": ""
}
`;
}

function normalizeMathExpression(raw) {
    return safeText(raw)
        .replace(/\s+/g, "")
        .replace(/×/g, "*")
        .replace(/x/gi, "*")
        .replace(/÷/g, "/");
}

function evaluateSimpleMathFromProblem(problem) {
    const normalized = normalizeMathExpression(problem);
    const match = normalized.match(/^(-?\d+(?:\.\d+)?)([\+\-\*\/])(-?\d+(?:\.\d+)?)$/);

    if (!match) return null;

    const a = Number(match[1]);
    const op = match[2];
    const b = Number(match[3]);

    if ([a, b].some(Number.isNaN)) return null;

    let answer = null;
    if (op === "+") answer = a + b;
    if (op === "-") answer = a - b;
    if (op === "*") answer = a * b;
    if (op === "/") {
        if (b === 0) return null;
        answer = a / b;
    }

    if (answer === null) return null;

    return {
        normalized,
        answer: String(answer)
    };
}

function validateSimpleMathConsistency(problem, correctAnswer) {
    const info = evaluateSimpleMathFromProblem(problem);
    if (!info) return { detectable: false };

    const cleanCorrect = normalizeMathExpression(correctAnswer);

    return {
        detectable: true,
        expected: info.answer,
        isValid: cleanCorrect === info.answer
    };
}

// =====================================
// ScorePath 21-258
// 일반 모드 공통 학습 신호 V1
// =====================================

function buildScorePathGeneralLearningSignalsV01(user) {

    // =====================================
    // 1. 등록된 과목 확인
    // =====================================

    const activeSubjects = new Set(
        (Array.isArray(user.subjects) ? user.subjects : [])
            .map(safeText)
            .filter(Boolean)
    );

    const history =
        Array.isArray(user.problemHistory)
            ? user.problemHistory
            : [];

    // 일반 모드의 임시 집계 ID
    // 실제 시험을 생성하지 않는다.
    const virtualExamId =
        "__scorepath_general_v01__";

    const unitsBySubject =
        new Map();

    const generalHistory = [];

    // =====================================
    // 2. 기존 문제풀이 기록 통합
    // =====================================

    for (const item of history) {

        const subject =
            safeText(item?.subject);

        const unit =
            safeText(item?.unit) ||
            "단원 미지정";

        // 유효하지 않은 기록 제외
        if (
            !subject ||

            (
                activeSubjects.size > 0 &&
                !activeSubjects.has(subject)
            ) ||

            (
                !safeText(item?.problem) &&
                !safeText(item?.problemImageKey)
            ) ||

            typeof item?.isCorrect !== "boolean"
        ) {
            continue;
        }

        // 원본 DB를 수정하지 않고
        // 계산용 기록만 생성한다.
        generalHistory.push({

            ...item,

            examId:
                virtualExamId,

            subject,
            unit
        });

        // =====================================
        // 과목별 단원 목록
        // =====================================

        if (!unitsBySubject.has(subject)) {

            unitsBySubject.set(
                subject,
                new Set()
            );
        }

        unitsBySubject
            .get(subject)
            .add(unit);
    }

    // =====================================
    // 3. 계산용 사용자 객체
    // =====================================

    const projectedUser = {

        ...user,

        problemHistory:
            generalHistory
    };

    const result = [];

    // =====================================
    // 4. 기존 숙련도 엔진 재사용
    // =====================================

    for (
        const [subject, units]
        of unitsBySubject
    ) {

        const virtualExam = {

            id: virtualExamId,

            subject,

            examRange:
                [...units]
        };

        // 시험 모드에서 사용하는
        // 동일한 숙련도 계산 함수
        const signals =
            buildScorePathLearningSignalsV01(
                projectedUser,
                virtualExam
            );

        // =====================================
        // 일반 전광판용 데이터
        // =====================================

        for (const item of signals) {

            result.push({

                subject,

                unit:
                    item.unit,

                // 고유 문제 수
                uniqueAttempts:
                    item.uniqueAttempts,

                // 고유 문제 첫 풀이 정답 수
                uniqueCorrectCount:
                    item.uniqueCorrectCount,

                // 데이터 충분성
                needsMoreEvidence:
                    item.needsMoreEvidence,

                // 추정 숙련도
                estimatedMastery:
                    item.estimatedMastery,

                // 학습 근거 수준
                evidenceLevel:
                    item.evidenceLevel,

                // 난이도 다양성
                hasDifficultyCoverage:
                    item.hasDifficultyCoverage,

                // 다음 학습 방향
                nextAction:
                    item.nextAction
            });
        }
    }

    return result;
}


// =====================================
// 기존 대시보드 함수
// =====================================

function buildDashboard(user) {
    ensureUserShape(user);

    const wrongNotes = [...user.notes];
    const solvedNotes = [...user.solvedNotes];
    const trashNotes = [...user.trashNotes];
    const planRule = getPlanRule(user.plan);

    const currentTime = now();

    // =====================================
    // 현재 약점 전체를 한 배열로 정리
    // =====================================

    const allWeaknesses =
        Object.values(user.weaknessProfile || {})
            .flatMap((subjectProfile) =>
                Object.entries(subjectProfile || {})
            )
            .map(([weaknessKey, weakness]) => ({
                weaknessKey,

                subject:
                    safeText(
                        weaknessKey.split("::")[0]
                    ) || "기타",

                label:
                    safeText(weakness?.label) ||
                    safeText(weakness?.weakConcept) ||
                    "분류되지 않은 약점",

                unit:
                    safeText(weakness?.unit),

                weakConcept:
                    safeText(weakness?.weakConcept),

                weakConceptDetail:
                    safeText(
                        weakness?.weakConceptDetail
                    ),

                wrongCount:
                    Number(weakness?.wrongCount || 0),

                correctCount:
                    Number(weakness?.correctCount || 0),

                reviewWrongCount:
                    Number(
                        weakness?.reviewWrongCount || 0
                    ),

                consecutiveCorrect:
                    Number(
                        weakness?.consecutiveCorrect || 0
                    ),

                weaknessScore:
                    Number(
                        weakness?.weaknessScore || 0
                    ),

                status:
                    weakness?.status || "green",

                updatedAt:
                    Number(weakness?.updatedAt || 0)
            }));

    // =====================================
    // 5단계 기존 기능
    // 오늘 복습 시간이 된 약점
    // =====================================

    const recommendedReviews =
        Object.values(user.reviewSchedule || {})
            .filter((schedule) => {
                if (!schedule) {
                    return false;
                }

                if (
                    schedule.masteryStatus ===
                    "mastered"
                ) {
                    return false;
                }

                const nextReviewAt =
                    Number(
                        schedule.nextReviewAt || 0
                    );

                if (!nextReviewAt) {
                    return false;
                }

                return (
                    nextReviewAt <= currentTime
                );
            })
            .sort((a, b) => {
                return (
                    Number(a.nextReviewAt || 0) -
                    Number(b.nextReviewAt || 0)
                );
            })
            .slice(0, 3)
            .map((schedule) => {
                const weakness =
                    allWeaknesses.find(
                        (item) =>
                            item.weaknessKey ===
                            schedule.weaknessKey
                    ) || null;

                return {
                    weaknessKey:
                        schedule.weaknessKey,

                    subject:
                        schedule.subject ||
                        weakness?.subject ||
                        "기타",

                    label:
                        schedule.label ||
                        weakness?.label ||
                        "분류되지 않은 약점",

                    stage:
                        Number(
                            schedule.stage || 1
                        ),

                    intervalDays:
                        Number(
                            schedule.intervalDays || 1
                        ),

                    nextReviewAt:
                        Number(
                            schedule.nextReviewAt || 0
                        ),

                    masteryStatus:
                        schedule.masteryStatus ||
                        "learning",

                    weaknessScore:
                        Number(
                            weakness?.weaknessScore || 0
                        ),

                    status:
                        weakness?.status || "green",

                    spacedCorrectCount:
                        Number(
                            schedule
                                .spacedCorrectCount || 0
                        ),

                    spacedWrongCount:
                        Number(
                            schedule
                                .spacedWrongCount || 0
                        )
                };
            });

    // =====================================
    // 6단계 - 오늘의 학습
    // =====================================

    // -------------------------------------
    // 1. 다시 풀어볼 문제
    //
    // 아직 해결되지 않은 오답 중
    // 반복해서 틀린 문제를 우선하고,
    // 같으면 최근 문제를 우선한다.
    // -------------------------------------

    const retryProblems =
        [...wrongNotes]
            .filter((note) => {
                return (
                    note &&
                    safeText(note.problem) &&
                    safeText(note.correctAnswer)
                );
            })
            .sort((a, b) => {
                const repeatDifference =
                    Number(
                        b.repeatWrongCount || 0
                    ) -
                    Number(
                        a.repeatWrongCount || 0
                    );

                if (repeatDifference !== 0) {
                    return repeatDifference;
                }

                return (
                    Number(
                        b.updatedAt ||
                        b.createdAt ||
                        0
                    ) -
                    Number(
                        a.updatedAt ||
                        a.createdAt ||
                        0
                    )
                );
            })
            .slice(0, 3)
            .map((note) => ({
                noteId: note.id,

                subject:
                    note.subject || "기타",

                problem:
                    note.problem,

                unit:
                    safeText(note.unit),

                weakConcept:
                    safeText(note.weakConcept),

                problemType:
                    safeText(note.problemType),

                errorType:
                    safeText(note.errorType),

                repeatWrongCount:
                    Number(
                        note.repeatWrongCount || 0
                    ),

                latestReviewResult:
                    safeText(
                        note.latestReviewResult
                    ),

                masteryStatus:
                    safeText(note.masteryStatus) ||
                    "learning"
            }));

    // -------------------------------------
    // 2. 오늘 복습할 개념
    //
    // 5단계의 간격 반복 스케줄을 그대로 사용.
    // -------------------------------------

    const reviewConcepts =
        recommendedReviews.map(
            (review) => ({
                weaknessKey:
                    review.weaknessKey,

                subject:
                    review.subject,

                label:
                    review.label,

                stage:
                    review.stage,

                intervalDays:
                    review.intervalDays,

                nextReviewAt:
                    review.nextReviewAt,

                weaknessScore:
                    review.weaknessScore,

                status:
                    review.status
            })
        );

    // -------------------------------------
    // 3. 약점 훈련
    //
    // 현재 약점 점수가 높은 순.
    // 이미 극복한 약점은 제외.
    // 최대 3개.
    // -------------------------------------

    const weaknessTraining =
        [...allWeaknesses]
            .filter((weakness) => {
                const schedule =
                    user.reviewSchedule?.[
                        weakness.weaknessKey
                    ];

                const mastered =
                    schedule &&
                    (
                        safeText(
                            schedule.masteryStatus
                        ) === "mastered" ||
                        Number(
                            schedule.stage || 0
                        ) >= 6
                    );

                return (
                    !mastered &&
                    weakness.wrongCount > 0
                );
            })
            .sort((a, b) => {
                if (
                    b.weaknessScore !==
                    a.weaknessScore
                ) {
                    return (
                        b.weaknessScore -
                        a.weaknessScore
                    );
                }

                if (
                    b.wrongCount !==
                    a.wrongCount
                ) {
                    return (
                        b.wrongCount -
                        a.wrongCount
                    );
                }

                return (
                    b.updatedAt -
                    a.updatedAt
                );
            })
            .slice(0, 3)
            .map((weakness) => ({
                weaknessKey:
                    weakness.weaknessKey,

                subject:
                    weakness.subject,

                label:
                    weakness.label,

                unit:
                    weakness.unit,

                weakConcept:
                    weakness.weakConcept,

                weaknessScore:
                    weakness.weaknessScore,

                status:
                    weakness.status,

                wrongCount:
                    weakness.wrongCount,

                correctCount:
                    weakness.correctCount,

                consecutiveCorrect:
                    weakness.consecutiveCorrect
            }));

    // -------------------------------------
    // 4. 가장 많이 틀린 약점
    //
    // wrongCount 우선.
    // 동률이면 weaknessScore가 높은 약점.
    // -------------------------------------

    const topWeakness =
        [...allWeaknesses]
            .filter(
                (weakness) =>
                    weakness.wrongCount > 0
            )
            .sort((a, b) => {
                if (
                    b.wrongCount !==
                    a.wrongCount
                ) {
                    return (
                        b.wrongCount -
                        a.wrongCount
                    );
                }

                if (
                    b.weaknessScore !==
                    a.weaknessScore
                ) {
                    return (
                        b.weaknessScore -
                        a.weaknessScore
                    );
                }

                return (
                    b.updatedAt -
                    a.updatedAt
                );
            })[0] || null;

    const todayLearning = {
        retryProblems,

        reviewConcepts,

        weaknessTraining,

        topWeakness:
            topWeakness
                ? {
                    weaknessKey:
                        topWeakness.weaknessKey,

                    subject:
                        topWeakness.subject,

                    label:
                        topWeakness.label,

                    unit:
                        topWeakness.unit,

                    weakConcept:
                        topWeakness.weakConcept,

                    weakConceptDetail:
                        topWeakness
                            .weakConceptDetail,

                    wrongCount:
                        topWeakness.wrongCount,

                    weaknessScore:
                        topWeakness.weaknessScore,

                    status:
                        topWeakness.status
                }
                : null,

        summary: {
            retryProblemCount:
                retryProblems.length,

            reviewConceptCount:
                reviewConcepts.length,

            weaknessTrainingCount:
                weaknessTraining.length
        }
    };

    // =====================================
    // 기존 취약 과목 계산
    // =====================================

    let weakestSubject = null;
    let maxWrong = -1;

    [
        "수학",
        "영어",
        "국어",
        "과학",
        "사회",
        "기계일반"
    ].forEach((subject) => {
        const count =
            wrongNotes.filter(
                (note) =>
                    note.subject === subject
            ).length;

        if (count > maxWrong) {
            maxWrong = count;
            weakestSubject = subject;
        }
    });

    // =====================================
    // Dashboard 반환
    // =====================================

    return {
        user: sanitizeUser(user),
        planRule,
        usageAi: user.usageAi,
        usageAdvanced:
            user.usageAdvanced,

        wrongNotes,
        solvedNotes,
        trashNotes,

        analysisCache:
            user.analysisCache,

        recommendedReviews,

        // =====================================
        // 기존 오늘의 학습 데이터
        // =====================================

        todayLearning,

        // =====================================
        // ScorePath 21-265
        // 일반 공부 시작 및 완료 기록
        // =====================================

        generalStudySummary: (() => {

            // =====================================
            // 1. 기존 일반 학습 기록 가져오기
            // =====================================

            const sessions =
                Array.isArray(
                    user.scorePathGeneralSessions
                )
                    ? user.scorePathGeneralSessions
                    : [];

            // =====================================
            // 2. 완료된 공부 기록
            // =====================================

            const completed =
                sessions
                    .filter(
                        item =>
                            item.status === "completed"
                    )
                    .sort(
                        (a, b) =>
                            Number(b.completedAt || 0) -
                            Number(a.completedAt || 0)
                    );

            // =====================================
            // 3. 진행 중인 공부 확인
            // =====================================

            const active =
                sessions.find(
                    item =>
                        item.status === "in_progress"
                ) || null;

            // =====================================
            // 4. 가장 최근 완료한 공부
            // =====================================

            const latest =
                completed[0] || null;

            // =====================================
            // 5. 대시보드에 전달할 데이터
            // =====================================

            return {

                // 누적 공부 완료 횟수
                completedCount:
                    completed.length,

                // 현재 진행 중인 공부
                activeStudy:
                    active
                        ? {
                            id:
                                active.id,

                            subject:
                                active.subject,

                            unit:
                                active.unit,

                            startedAt:
                                active.startedAt
                        }
                        : null,

                // 최근 완료한 공부
                lastCompleted:
                    latest
                        ? {
                            id:
                                latest.id,

                            subject:
                                latest.subject,

                            unit:
                                latest.unit,

                            actualMinutes:
                                latest.actualMinutes,

                            attempts:
                                latest.attempts,

                            correctAttempts:
                                latest.correctAttempts,

                            uniqueProblems:
                                latest.uniqueProblems,

                            completedAt:
                                latest.completedAt
                        }
                        : null
            };

        })(),

        // =====================================
        // ScorePath 21-258
        // 일반 전광판 공통 학습 신호
        // =====================================

        generalLearningSignals:
            buildScorePathGeneralLearningSignalsV01(
                user
            ),

        // =====================================
        // 기존 취약 과목
        // =====================================

        weakestSubject:
            maxWrong > 0
                ? weakestSubject
                : null,

        advancedUsage: {
            used:
                user.usageAdvanced.count,

            limit:
                Number(
                    planRule.advancedDaily || 0
                ),

            remaining:
                Math.max(
                    0,

                    Number(
                        planRule.advancedDaily || 0
                    ) -
                    Number(
                        user.usageAdvanced.count || 0
                    )
                )
        }
    };
}

function requireAuth(req, res, next) {
    const db = readDb(scorePathNeon ? { id: String(req.session?.userId || '__no_login__') } : null);
    const user = db.users.find((u) => u.id === req.session.userId);

    if (!user) {
        return res.status(401).json({ error: "로그인이 필요합니다." });
    }

    ensureUserShape(user);
    // Prevent leftover beta/test premium flags from becoming real paid access.
    if ((process.env.NODE_ENV === 'production' || process.env.SCOREPATH_PAYMENT_MODE === 'portone') &&
        user.plan !== 'free' &&
        (!app.locals.scorePathCommerceHasPaid || !app.locals.scorePathCommerceHasPaid(user.id))) {
        user.plan = 'free';
        writeDb(db);
    }
    req.db = db;
    req.currentUser = user;
    next();
}

// 메모리형 업로드 폭주 방지: 초기 출시용(멀티 인스턴스 배포 시 공유 저장소로 교체)
const scorePathPhotoUploadRateV01 = new Map();

app.post(
    "/api/problem-image/upload",
    requireAuth,
    async (req, res) => {
        try {
            const {
                imageBase64,
                contentType
            } = req.body;

            if (!imageBase64) {
                return res.status(400).json({
                    message:
                        "업로드할 문제 사진이 없습니다."
                });
            }

            const allowedTypes = [
                "image/webp",
                "image/jpeg",
                "image/png"
            ];

            const safeContentType =
                allowedTypes.includes(contentType)
                    ? contentType
                    : "image/webp";

            const base64Data =
                String(imageBase64)
                    .replace(
                        /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
                        ""
                    );

            const imageBuffer =
                Buffer.from(
                    base64Data,
                    "base64"
                );

            if (
                imageBuffer.length === 0 ||
                imageBuffer.length > 2 * 1024 * 1024
            ) {
                return res.status(400).json({
                    message:
                        "문제 사진 크기가 올바르지 않습니다."
                });
            }

            // MIME 헤더 위장 파일 차단 (프론트 우회 요청 방어)
            const isPng = imageBuffer.subarray(0, 8).equals(
                Buffer.from([137,80,78,71,13,10,26,10])
            );
            const isJpeg = imageBuffer.length >= 3 &&
                imageBuffer[0] === 255 && imageBuffer[1] === 216 && imageBuffer[2] === 255;
            const isWebp = imageBuffer.toString("ascii",0,4) === "RIFF" &&
                imageBuffer.toString("ascii",8,12) === "WEBP";
            if (!(
                (safeContentType === "image/png" && isPng) ||
                (safeContentType === "image/jpeg" && isJpeg) ||
                (safeContentType === "image/webp" && isWebp)
            )) {
                return res.status(400).json({ error: "사진 파일 형식이 일치하지 않습니다." });
            }

            // 사용자별 최근 1시간 업로드 최대 60회: 3장 크롭 반복 악용 제한
            const owner = String(req.currentUser.id);
            const nowMs = Date.now();
            const recent = (scorePathPhotoUploadRateV01.get(owner) || [])
                .filter(time => time > nowMs - 3600000);
            if (recent.length >= 60) {
                return res.status(429).json({ error: "사진 업로드 요청이 너무 많습니다. 잠시 후 다시 시도해주세요." });
            }
            recent.push(nowMs);
            scorePathPhotoUploadRateV01.set(owner, recent);

            const extension =
                safeContentType === "image/png"
                    ? "png"
                    : safeContentType === "image/jpeg"
                    ? "jpg"
                    : "webp";

            const imageKey =
                `problem-images/${Date.now()}-${randomUUID()}.${extension}`;

            await r2Client.send(
                new PutObjectCommand({
                    Bucket:
                        r2BucketName,

                    Key:
                        imageKey,

                    Body:
                        imageBuffer,

                    ContentType:
                        safeContentType
                })
            );

            console.log(
                "R2 PROBLEM IMAGE UPLOADED:",
                {
                    imageKey,
                    bytes:
                        imageBuffer.length
                }
            );

            req.session.pendingProblemImageKeys =
    Array.isArray(
        req.session
            .pendingProblemImageKeys
    )
        ? req.session
            .pendingProblemImageKeys
        : [];

if (
    !req.session
        .pendingProblemImageKeys
        .includes(imageKey)
) {
    req.session
        .pendingProblemImageKeys
        .push(imageKey);
}

return res.json({
    success: true,
    problemImageKey: imageKey,
    size: imageBuffer.length
});
        } catch (error) {
            console.error(
                "R2 PROBLEM IMAGE UPLOAD ERROR:",
                error
            );

            return res.status(500).json({
                message:
                    "문제 사진 저장에 실패했습니다."
            });
        }
    }
);

app.get(
    "/api/problem-image",
    requireAuth,
    async (req, res) => {
        try {
            const imageKey =
                safeText(
                    req.query.key
                );

            if (
                !imageKey ||
                !imageKey.startsWith(
                    "problem-images/"
                )
            ) {
                return res
                    .status(400)
                    .json({
                        message:
                            "올바른 문제 사진 키가 아닙니다."
                    });
            }

            const user =
                req.currentUser;

            ensureUserShape(user);

            const ownsImage =
                [
                    ...(user.notes || []),
                    ...(user.solvedNotes || []),
                    ...(user.trashNotes || [])
                ].some(
                    (note) =>
                        safeText(
                            note.problemImageKey
                        ) === imageKey
                );

            if (!ownsImage) {
                return res
                    .status(403)
                    .json({
                        message:
                            "이 문제 사진을 볼 권한이 없습니다."
                    });
            }

            const result =
                await r2Client.send(
                    new GetObjectCommand({
                        Bucket:
                            r2BucketName,

                        Key:
                            imageKey
                    })
                );

            if (!result.Body) {
                return res
                    .status(404)
                    .json({
                        message:
                            "문제 사진을 찾을 수 없습니다."
                    });
            }

            res.setHeader(
                "Content-Type",
                result.ContentType ||
                    "image/webp"
            );

            res.setHeader(
                "Cache-Control",
                "private, max-age=3600"
            );

            result.Body.pipe(res);

        } catch (error) {
            console.error(
                "R2 PROBLEM IMAGE READ ERROR:",
                error
            );

            if (
                error?.name ===
                "NoSuchKey"
            ) {
                return res
                    .status(404)
                    .json({
                        message:
                            "문제 사진을 찾을 수 없습니다."
                    });
            }

            return res
                .status(500)
                .json({
                    message:
                        "문제 사진을 불러오지 못했습니다."
                });
        }
    }
);

// =====================================
// ScorePath 21-358
// 로그인 및 회원가입 요청 제한
// =====================================

const scorePathAuthRateLimitsV01 = new Map();

function scorePathAuthRateLimitV01(req, res, next) {

    // 개발 환경에서는 기존 테스트 유지
    if (
        process.env.NODE_ENV !== "production" ||
        req.method !== "POST"
    ) {
        return next();
    }

    const isRegister =
        req.path === "/api/auth/register";

    const windowMs =
        isRegister
            ? 60 * 60 * 1000
            : 15 * 60 * 1000;

    const maxRequests =
        isRegister ? 10 : 20;

    const ip =
        req.ip ||
        req.socket.remoteAddress ||
        "unknown";

    const key =
        `${isRegister ? "register" : "login"}:${ip}`;

    const time = Date.now();

    const previous =
        scorePathAuthRateLimitsV01.get(key);

    const entry =
        !previous || time >= previous.resetAt
            ? {
                count: 0,
                resetAt: time + windowMs
            }
            : previous;

    if (entry.count >= maxRequests) {

        res.set(
            "Retry-After",
            String(
                Math.max(
                    1,
                    Math.ceil(
                        (entry.resetAt - time) / 1000
                    )
                )
            )
        );

        return res.status(429).json({
            error:
                "요청이 너무 많습니다. 잠시 후 다시 시도해주세요."
        });
    }

    entry.count += 1;

    scorePathAuthRateLimitsV01.set(
        key,
        entry
    );

    return next();
}

// 만료된 기록 정리
setInterval(() => {

    const time = Date.now();

    for (
        const [key, entry]
        of scorePathAuthRateLimitsV01
    ) {

        if (time >= entry.resetAt) {
            scorePathAuthRateLimitsV01.delete(key);
        }
    }

}, 15 * 60 * 1000).unref();

app.use(
    [
        "/api/auth/register",
        "/api/auth/login"
    ],
    scorePathAuthRateLimitV01
);

app.post("/api/auth/register", async (req, res) => {
    try {
        const { name, email, password } = req.body;

        const cleanName = safeText(name);
        const cleanEmail = normalizeEmail(email);
        const cleanPassword = safeText(password);

        // Beta entry is restricted to 14+. Under-14 onboarding requires guardian consent.
        if (req.body?.age14Confirmed !== true) {
            return res.status(400).json({error:'베타 가입은 만 14세 이상만 가능합니다. 만 14세 미만은 보호자 동의 절차 준비 후 이용할 수 있습니다.'});
        }

        if (!cleanName || !cleanEmail || !cleanPassword) {
            return res.status(400).json({ error: "이름, 이메일, 비밀번호를 모두 입력해주세요." });
        }

        if (
            cleanPassword.length < 8 ||
            Buffer.byteLength(cleanPassword, "utf8") > 72
        ) {
            return res.status(400).json({
                error: "비밀번호는 8자 이상, UTF-8 기준 72바이트 이하로 입력해주세요."
            });
        }

        const db = readDb(scorePathNeon ? { email: cleanEmail } : null);

        const exists = db.users.some(
  (u) => normalizeEmail(u.email) === cleanEmail
);

        if (exists) {
            return res.status(409).json({ error: "이미 가입된 이메일입니다." });
        }

        const passwordHash = await bcrypt.hash(cleanPassword, 10);

        const newUser = {
            id: randomUUID(),
            name: cleanName,
            email: cleanEmail,
            passwordHash,
            plan: "free",
            createdAt: now(),
            usageAi: { date: todayString(), count: 0 },
            usageAdvanced: { date: todayString(), count: 0, usedKeys: [] },
            notes: [],
            solvedNotes: [],
            trashNotes: [],
            analysisCache: {},
            subjects: [...DEFAULT_SUBJECTS]
        };

        db.users.push(newUser);
        writeDb(db);

        // =====================================
        // ScorePath 21-359
        // 회원가입 후 세션 재발급
        // =====================================

        const pendingProblemImageKeys =
            !req.session.userId &&
            Array.isArray(
                req.session.pendingProblemImageKeys
            )
                ? [...req.session.pendingProblemImageKeys]
                : [];

        await new Promise((resolve, reject) => {

            req.session.regenerate((error) => {

                if (error) {
                    return reject(error);
                }

                req.session.userId = newUser.id;

                // 로그인 전 업로드한 임시 사진 정보 유지
                if (pendingProblemImageKeys.length > 0) {

                    req.session.pendingProblemImageKeys =
                        pendingProblemImageKeys;
                }

                req.session.save((saveError) => {

                    if (saveError) {
                        return reject(saveError);
                    }

                    resolve();
                });
            });
        });

        return res.json({
            message: "회원가입이 완료되었습니다.",
            dashboard: buildDashboard(newUser)
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "회원가입 중 오류가 발생했습니다." });
    }
});

app.post("/api/subjects/add", requireAuth, (req, res) => {
    const user = req.currentUser;
    ensureUserShape(user);

    const subject = String(req.body.subject || "").trim();

    if (!subject) {
        return res.status(400).json({
            error: "추가할 과목을 입력해주세요."
        });
    }

    if (subject.length > 20) {
        return res.status(400).json({
            error: "과목 이름은 20자 이하로 입력해주세요."
        });
    }

    const exists = user.subjects.some(
        (item) => item.toLowerCase() === subject.toLowerCase()
    );

    if (exists) {
        return res.status(409).json({
            error: "이미 추가된 과목입니다."
        });
    }

    user.subjects.push(subject);

    writeDb(req.db);

    return res.json({
        message: `${subject} 과목을 추가했습니다.`,
        subjects: user.subjects,
        dashboard: buildDashboard(user)
    });
});

app.post("/api/subjects/delete", requireAuth, (req, res) => {
    const user = req.currentUser;
    ensureUserShape(user);

    const subject = String(req.body.subject || "").trim();

    if (!subject) {
        return res.status(400).json({
            error: "삭제할 과목을 선택해주세요."
        });
    }

    if (!user.subjects.includes(subject)) {
        return res.status(404).json({
            error: "존재하지 않는 과목입니다."
        });
    }

    if (user.subjects.length <= 1) {
        return res.status(400).json({
            error: "과목은 최소 1개 이상 남아 있어야 합니다."
        });
    }

    user.subjects = user.subjects.filter(
        (item) => item !== subject
    );

    writeDb(req.db);

    return res.json({
        message: `${subject} 과목을 삭제했습니다.`,
        subjects: user.subjects,
        dashboard: buildDashboard(user)
    });
});

app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        const cleanEmail = normalizeEmail(email);
        const cleanPassword = safeText(password);

        if (!cleanEmail || !cleanPassword) {
            return res.status(400).json({
                error: "이메일과 비밀번호를 모두 입력해 주세요."
            });
        }

        const db = readDb(scorePathNeon ? { email: cleanEmail } : null);

        const matchedUsers = db.users.filter(
            (u) => normalizeEmail(u.email) === cleanEmail
        );

        if (matchedUsers.length === 0) {
            return res.status(401).json({
                error: "이메일 또는 비밀번호가 올바르지 않습니다."
            });
        }

        if (matchedUsers.length > 1) {
            return res.status(409).json({
                error: "중복된 계정 정보가 발견되었습니다. 관리자에게 문의해 주세요."
            });
        }

        const user = matchedUsers[0];

        const ok = await bcrypt.compare(
            cleanPassword,
            user.passwordHash
        );

        if (!ok) {
            return res.status(401).json({
                error: "이메일 또는 비밀번호가 올바르지 않습니다."
            });
        }

        ensureUserShape(user);
        writeDb(db);

        // =====================================
        // ScorePath 21-360
        // 로그인 성공 시 세션 재발급
        // =====================================

        const pendingProblemImageKeys =
            !req.session.userId &&
            Array.isArray(
                req.session.pendingProblemImageKeys
            )
                ? [...req.session.pendingProblemImageKeys]
                : [];

        await new Promise((resolve, reject) => {

            req.session.regenerate((error) => {

                if (error) {
                    return reject(error);
                }

                req.session.userId = user.id;

                // 로그인 전 임시 사진 정보 유지
                if (pendingProblemImageKeys.length > 0) {

                    req.session.pendingProblemImageKeys =
                        pendingProblemImageKeys;
                }

                req.session.save((saveError) => {

                    if (saveError) {
                        return reject(saveError);
                    }

                    resolve();
                });
            });
        });

        return res.json({
            message: "로그인되었습니다.",
            dashboard: buildDashboard(user)
        });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error: "로그인 중 오류가 발생했습니다."
        });
    }
});

// =====================================
// ScorePath 21-361
// 안전한 로그아웃 처리
// =====================================

app.post("/api/auth/logout", (req, res) => {

    req.session.destroy((error) => {

        if (error) {

            console.error(
                "SCOREPATH LOGOUT ERROR:",
                error
            );

            return res.status(500).json({
                error:
                    "로그아웃 처리 중 오류가 발생했습니다."
            });
        }

        // 21-356에서 설정한 세션 쿠키 제거
        res.clearCookie("scorepath.sid", {
            path: "/"
        });

        return res.json({
            message: "로그아웃되었습니다."
        });
    });
});

// =====================================
// ScorePath 21-340
// 일반 모드 검증 진행률 조회
// AI 호출 없음
// =====================================

app.get(
    "/api/scorepath/general-study/verification-progress",
    requireAuth,
    (req, res) => {

        try {

            const user = req.currentUser;
            ensureUserShape(user);

            const session = (
                user.scorePathGeneralSessions || []
            ).find(
                item =>
                    item.status === "in_progress"
            );

            if (!session) {

                return res.json({
                    active: false,
                    verificationCount: 0,
                    verificationRequiredCount: 2
                });
            }

            const startedAt =
                Number(session.startedAt);

            if (
                !Number.isFinite(startedAt) ||
                startedAt <= 0
            ) {

                return res.status(409).json({
                    error:
                        "일반 공부 시작 시각을 확인할 수 없습니다."
                });
            }

            const history =
                Array.isArray(user.problemHistory)
                    ? user.problemHistory
                    : [];

            const recordTime = record =>
                Number(
                    record.solvedAt ||
                    record.createdAt ||
                    0
                );

            const sameUnit = record =>
                safeText(record.subject) ===
                    session.subject &&
                safeText(record.unit) ===
                    session.unit;

            // 공부 시작 이전에 풀었던 문제
            const alreadySolved = new Set(

                history

                    .filter(record =>
                        sameUnit(record) &&
                        recordTime(record) <= startedAt
                    )

                    .map(record =>
                        getProblemIdentity(
                            record.problem,
                            record.problemImageKey
                        )
                    )

                    .filter(Boolean)
            );

            // 공부 시작 이후 새로운 문제
            const newAttempts = history

                .filter(record =>

                    sameUnit(record) &&

                    !safeText(record.examId) &&

                    safeText(record.sourceType) ===
                        "normal" &&

                    typeof record.isCorrect ===
                        "boolean" &&

                    recordTime(record) > startedAt
                )

                .sort(
                    (a, b) =>
                        recordTime(a) -
                        recordTime(b)
                );

            // 동일 문제 중복 집계 방지
            const firstAttempts = new Map();

            for (const record of newAttempts) {

                const key =
                    getProblemIdentity(
                        record.problem,
                        record.problemImageKey
                    );

                if (
                    !key ||
                    alreadySolved.has(key) ||
                    firstAttempts.has(key)
                ) {
                    continue;
                }

                firstAttempts.set(
                    key,
                    record
                );
            }

            return res.json({

                active: true,

                sessionId:
                    session.id,

                subject:
                    session.subject,

                unit:
                    session.unit,

                verificationStarted:
                    Boolean(
                        session.verificationStartedAt
                    ),

                verificationCount:
                    Math.min(
                        2,
                        firstAttempts.size
                    ),

                verificationRequiredCount: 2
            });

        } catch (error) {

            console.error(
                "GENERAL VERIFICATION PROGRESS ERROR:",
                error
            );

            return res.status(500).json({
                error:
                    "일반 학습 검증 진행률 조회에 실패했습니다."
            });
        }
    }
);


// =====================================
// ScorePath 21-266
// 일반 모드 공부 시작 / 완료 API
// =====================================

app.post(
    "/api/scorepath/general-study",
    requireAuth,
    (req, res) => {

        try {

            const user =
                req.currentUser;

            ensureUserShape(user);

            // =====================================
            // 기존 기록 확인
            // =====================================

            if (
                !Array.isArray(
                    user.scorePathGeneralSessions
                )
            ) {

                user.scorePathGeneralSessions = [];
            }

            const sessions =
                user.scorePathGeneralSessions;

            const action =
                safeText(req.body?.action);

            // =====================================
            // 1. 공부 시작
            // =====================================

            if (action === "start") {

                const subject =
                    safeText(req.body?.subject);

                const unit =
                    safeText(req.body?.unit);

                 // =====================================
                // ScorePath 21-271
                // 일반 공부 시작 전 입력 검증
                // =====================================

                if (
                    !subject ||
                    !unit ||

                    subject.length > 80 ||
                    unit.length > 80 ||

                    !(
                        Array.isArray(user.subjects) &&
                        user.subjects.includes(subject)
                    )
                ) {

                    return res.status(400).json({
                        error:
                            "일반 공부를 시작하려면 " +
                            "등록된 과목과 단원을 선택해주세요."
                    });
                }

                // =====================================
                // 진행 중인 시험 공부 보호
                // =====================================

                const activeExamStudy =
                    (
                        Array.isArray(
                            user.scorePathStudySessions
                        )
                            ? user.scorePathStudySessions
                            : []
                    ).some(
                        item =>
                            item.status === "in_progress"
                    );

                if (activeExamStudy) {

                    return res.status(409).json({
                        error:
                            "진행 중인 시험 공부가 있습니다. " +
                            "기존 시험 공부를 먼저 완료해주세요."
                    });
                }

                // =====================================
                // 기존 일반 공부 확인
                // =====================================

                const existing =
                    sessions.find(
                        item =>
                            item.status === "in_progress"
                    );

                // 같은 공부라면 기존 세션 복원
                if (
                    existing &&
                    existing.subject === subject &&
                    existing.unit === unit
                ) {

                    return res.json({

                        message:
                            "진행 중인 공부를 불러왔습니다.",

                        session:
                            existing,

                        restored: true
                    });
                }

                // =====================================
                // ScorePath 21-280
                // 기존 일반 공부 보호
                // =====================================

                // 다른 일반 공부는 확인 없이
                // 자동으로 취소하지 않는다.

                if (existing) {

                    const replaceSessionId =
                        safeText(req.body?.replaceSessionId);

                    // =====================================
                    // 1. 전환 확인이 없는 경우
                    // =====================================

                    if (
                        replaceSessionId !==
                        safeText(existing.id)
                    ) {

                        return res.status(409).json({

                            code:
                                "GENERAL_STUDY_ACTIVE",

                            error:
                                "다른 일반 공부가 진행 중입니다. " +
                                "기존 공부를 완료하거나 전환을 확인해주세요.",

                            activeStudy: {

                                id:
                                    existing.id,

                                subject:
                                    existing.subject,

                                unit:
                                    existing.unit,

                                startedAt:
                                    existing.startedAt
                            }
                        });
                    }

                    // =====================================
                    // 2. 확인한 기존 공부만 취소
                    // =====================================

                    existing.status =
                        "cancelled";

                    existing.cancelledAt =
                        now();
                }

                // =====================================
                // 새로운 학습 세션
                // =====================================

                const session = {

                    id:
                        randomUUID(),

                    subject,

                    unit,

                    status:
                        "in_progress",

                    startedAt:
                        now(),

                    completedAt:
                        null
                };

                sessions.push(session);

                // DB 저장
                writeDb(req.db);

                return res.json({

                    message:
                        "일반 공부가 시작되었습니다.",

                    session,

                    restored: false
                });
            }

            // =====================================
            // 2. 공부 완료
            // =====================================

            if (action === "complete") {

                const sessionId =
                    safeText(
                        req.body?.sessionId
                    );

                const session =
                    sessions.find(
                        item =>
                            item.id === sessionId
                    );

                if (!session) {

                    return res.status(404).json({
                        error:
                            "진행 중인 공부 기록을 찾지 못했습니다."
                    });
                }

                // =====================================
                // 중복 완료 방지
                // =====================================

                if (
                    session.status === "completed"
                ) {

                    return res.json({

                        message:
                            "이미 완료된 공부입니다.",

                        duplicate: true,

                        session,

                        dashboard:
                            buildDashboard(user)
                    });
                }

                if (
                    session.status !== "in_progress"
                ) {

                    return res.status(409).json({
                        error:
                            "현재 완료할 수 없는 학습 기록입니다."
                    });
                }

                // =====================================
                // ScorePath 21-286
                // 학습 후 짧은 검증
                // =====================================

                // =====================================
                // ScorePath 21-341
                // 공부 시작부터 검증 문제 집계
                // =====================================

                const studyStartedAt =
                    Number(session.startedAt);

                if (
                    !Number.isFinite(studyStartedAt) ||
                    studyStartedAt <= 0
                ) {

                    return res.status(409).json({
                        error:
                            "일반 공부 시작 시각을 확인할 수 없습니다."
                    });
                }

                // 이전 버전에서 검증을 시작했더라도
                // 공부 시작 이후 풀이 기록을 유지한다.
                if (
                    Number(session.verificationStartedAt) !==
                    studyStartedAt
                ) {

                    session.verificationStartedAt =
                        studyStartedAt;

                    writeDb(req.db);
                }

                // 첫 클릭에서 0/2로 초기화하지 않는다.
                // 아래의 기존 고유 문제 집계를 실행한다.

                // =====================================
                // 2. 검증 건너뛰기
                // =====================================

                if (req.body?.verificationSkip === true) {

                    session.verification = {

                        status: "skipped",

                        uniqueCount: 0,

                        correctCount: 0,

                        checkedAt: now()
                    };

                } else {

                    // =====================================
                    // 3. 문제풀이 기록 확인
                    // =====================================

                    const verificationStartedAt =
                        Number(session.verificationStartedAt);

                    const historyForVerification =
                        Array.isArray(user.problemHistory)
                            ? user.problemHistory
                            : [];

                    const sameUnit = (record) =>
                        safeText(record.subject) === session.subject &&
                        safeText(record.unit) === session.unit;

                    const recordTime = (record) =>
                        Number(
                            record.solvedAt ||
                            record.createdAt ||
                            0
                        );

                    // =====================================
                    // 4. 기존에 풀었던 문제 제외
                    // =====================================

                    const alreadySolved = new Set(

                        historyForVerification

                            .filter(record =>

                                sameUnit(record) &&

                                recordTime(record) <=
                                    verificationStartedAt
                            )

                            .map(record =>

                                getProblemIdentity(
                                    record.problem,
                                    record.problemImageKey
                                )
                            )

                            .filter(Boolean)
                    );

                    // =====================================
                    // 5. 검증 시작 이후의 새 문제
                    // =====================================

                    const newAttempts =
                        historyForVerification

                            .filter(record =>

                                sameUnit(record) &&

                                !safeText(record.examId) &&

                                safeText(record.sourceType) ===
                                    "normal" &&

                                typeof record.isCorrect ===
                                    "boolean" &&

                                recordTime(record) >
                                    verificationStartedAt
                            )

                            .sort(
                                (a, b) =>
                                    recordTime(a) -
                                    recordTime(b)
                            );

                    // =====================================
                    // 6. 동일 문제 반복 제출 제외
                    // =====================================

                    const firstAttempts =
                        new Map();

                    for (const record of newAttempts) {

                        const key =
                            getProblemIdentity(
                                record.problem,
                                record.problemImageKey
                            );

                        if (

                            !key ||

                            alreadySolved.has(key) ||

                            firstAttempts.has(key)

                        ) {
                            continue;
                        }

                        firstAttempts.set(
                            key,
                            record
                        );
                    }

                    // =====================================
                    // 7. 새로운 문제 2개 확인
                    // =====================================

                    const checks =
                        [...firstAttempts.values()]
                            .slice(0, 2);

                    if (checks.length < 2) {

                        return res.json({

                            verificationRequired: true,

                            verificationCount:
                                checks.length,

                            verificationRequiredCount: 2,

                            session
                        });
                    }

                    // =====================================
                    // 8. 검증 결과 저장
                    // =====================================

                    session.verification = {

                        status: "completed",

                        uniqueCount:
                            checks.length,

                        correctCount:
                            checks.filter(
                                record =>
                                    record.isCorrect === true
                            ).length,

                        checkedAt:
                            now()
                    };
                }

                // =====================================
                // 기존 공부 완료 처리
                // =====================================

                const completedAt =
                    now();

                // =====================================
                // 3. 실제 경과 시간
                // =====================================

                const elapsedMinutes =
                    Math.max(
                        0,
                        (
                            completedAt -
                            Number(session.startedAt)
                        ) / 60000
                    );

                session.actualMinutes =
                    Math.round(
                        elapsedMinutes * 10
                    ) / 10;

                // =====================================
                // 4. 실제 문제풀이 기록 확인
                // =====================================

                const history =
                    Array.isArray(
                        user.problemHistory
                    )
                        ? user.problemHistory
                        : [];

                const attempts =
                    history.filter((item) => {

                        const solvedAt =
                            Number(
                                item.solvedAt ||
                                item.createdAt ||
                                0
                            );

                        return (

                            // 일반 모드 기록만 사용
                            !safeText(item.examId) &&

                            // 동일 과목
                            safeText(item.subject) ===
                                session.subject &&

                            // 동일 단원
                            safeText(item.unit) ===
                                session.unit &&

                            // 학습 진행 중 기록
                            solvedAt >=
                                session.startedAt &&

                            solvedAt <=
                                completedAt &&

                            typeof item.isCorrect ===
                                "boolean"
                        );
                    });

                // =====================================
                // 5. 정답 및 고유 문제 수
                // =====================================

                const correctAttempts =
                    attempts.filter(
                        item =>
                            item.isCorrect === true
                    ).length;

                const problemKeys =
                    new Set();

                attempts.forEach((item) => {

                    const key =
                        getProblemIdentity(
                            item.problem,
                            item.problemImageKey
                        );

                    if (key) {

                        problemKeys.add(key);
                    }
                });

                // =====================================
                // 6. 완료 기록 저장
                // =====================================

                session.status =
                    "completed";

                session.completedAt =
                    completedAt;

                session.attempts =
                    attempts.length;

                session.correctAttempts =
                    correctAttempts;

                session.uniqueProblems =
                    problemKeys.size;

                // =====================================
                // 7. DB 저장
                // =====================================

                writeDb(req.db);

                // 최신 학습 기록으로 대시보드 재계산
                const dashboard =
                    buildDashboard(user);

                return res.json({

                    message:
                        "공부 완료 기록이 저장되었습니다.",

                    duplicate: false,

                    session,

                    dashboard
                });
            }

            // =====================================
            // ScorePath 21-274
            // 일반 공부 직접 취소
            // =====================================

            if (action === "cancel") {

                const sessionId =
                    safeText(req.body?.sessionId);

                if (!sessionId) {
                    return res.status(400).json({
                        error: "취소할 공부 기록을 선택해주세요."
                    });
                }

                const session = sessions.find(
                    item => item.id === sessionId
                );

                if (!session) {
                    return res.status(404).json({
                        error: "공부 기록을 찾지 못했습니다."
                    });
                }

                if (session.status !== "in_progress") {
                    return res.status(409).json({
                        error: "이미 종료된 공부입니다."
                    });
                }

                // 실제 문제풀이 기록은 변경하지 않는다.
                session.status = "cancelled";
                session.cancelledAt = now();

                writeDb(req.db);

                return res.json({
                    message: "일반 공부를 취소했습니다.",
                    dashboard: buildDashboard(user)
                });
            }

            return res.status(400).json({
                error:
                    "지원하지 않는 학습 요청입니다."
            });

        } catch (error) {

            console.error(
                "GENERAL STUDY ERROR:",
                error
            );

            return res.status(500).json({
                error:
                    "일반 공부 기록을 처리하지 못했습니다."
            });
        }
    }
);


// =====================================
// 기존 로그인 상태 확인 API
// =====================================

app.get("/api/auth/me", requireAuth, (req, res) => {
    writeDb(req.db);

    return res.json({
        dashboard: buildDashboard(req.currentUser)
    });
});


// =====================================
// 7단계 - 시험 모드
// 7-1 시험 일정 저장 / 조회 / 삭제
// =====================================


// =====================================
// ScorePath 21-84
// 기존 문제은행 조회 API
// =====================================

// =====================================
// ScorePath 21-93
// 기존 문제의 정답 수정 API
// =====================================

app.post(
    "/api/scorepath/problem-bank/correct-answer",
    requireAuth,
    (req, res) => {

        const user = req.currentUser;

        ensureUserShape(user);

        const subject =
            safeText(req.body?.subject);

        const problem =
            safeText(req.body?.problem);

        const imageKey =
            safeText(req.body?.problemImageKey);

        const correctedAnswer =
            safeText(req.body?.correctAnswer);

        const normalize = (value) =>
            safeText(value)
                .replace(/\s+/g, " ")
                .toLowerCase();

        // =====================================
        // 입력값 확인
        // =====================================

        if (
            !subject ||
            (!problem && !imageKey) ||
            !correctedAnswer ||
            correctedAnswer.length > 100
        ) {
            return res.status(400).json({
                error:
                    "문제와 수정할 정답을 확인해주세요."
            });
        }

        // =====================================
        // 실제 저장된 문제인지 확인
        // =====================================

        const originals = [
            ...(user.notes || []),
            ...(user.solvedNotes || []),
            ...(user.trashNotes || [])
        ].filter((note) =>

            safeText(note.subject) === subject &&

            normalize(note.problem) ===
                normalize(problem) &&

            safeText(note.problemImageKey) ===
                imageKey
        );

        if (!originals.length) {
            return res.status(404).json({
                error: "원본 문제를 찾을 수 없습니다."
            });
        }

        // =====================================
        // 문제은행 전용 정답 보관
        // =====================================

        const bankKey = JSON.stringify([
            subject,
            normalize(problem),
            imageKey
        ]);

        if (
            !user.scorePathAnswerOverrides ||
            typeof user.scorePathAnswerOverrides !==
                "object" ||
            Array.isArray(
                user.scorePathAnswerOverrides
            )
        ) {
            user.scorePathAnswerOverrides = {};
        }

        const previousAnswer =
            safeText(
                user.scorePathAnswerOverrides[bankKey]
                    ?.correctAnswer
            ) ||
            safeText(originals[0]?.correctAnswer);

        user.scorePathAnswerOverrides[bankKey] = {
            correctAnswer: correctedAnswer,

            checkedBy: "user",

            updatedAt: now()
        };

        // =====================================
        // 기존 ScorePath 풀이 기록 재채점
        // =====================================

        let regraded = 0;

        for (
            const record of
            (user.problemHistory || [])
        ) {

            if (
                safeText(record.subject) !==
                subject
            ) {
                continue;
            }

            const sameProblem =
                normalize(record.problem) ===
                normalize(problem);

            const sameImage =
                imageKey &&
                safeText(record.problemImageKey) ===
                imageKey;

            const copiedPhotoPlaceholder =
                normalize(record.problem)
                    .startsWith(
                        "[기존 사진 문제]"
                    );

            const matches =
                imageKey
                    ? sameImage &&
                      (
                          sameProblem ||
                          copiedPhotoPlaceholder
                      )
                    : !safeText(
                        record.problemImageKey
                    ) && sameProblem;

            if (!matches) {
                continue;
            }

            // 최초 채점 결과 보존
            if (
                !record.originalGradingBeforeCorrection
            ) {
                record.originalGradingBeforeCorrection = {
                    correctAnswer:
                        record.correctAnswer,

                    isCorrect:
                        record.isCorrect,

                    result:
                        record.result
                };
            }

            const isCorrect =
                answersEquivalent(
                    record.userAnswer,
                    correctedAnswer,
                    problem || record.problem
                );

            record.correctAnswer =
                correctedAnswer;

            record.isCorrect =
                isCorrect;

            record.result =
                isCorrect
                    ? "correct"
                    : "wrong";

            record.answerCorrectedAt =
                now();

            regraded++;
        }

        // =====================================
        // 수정 이력 보존
        // =====================================

        if (
            !Array.isArray(
                user.scorePathAnswerCorrectionLog
            )
        ) {
            user.scorePathAnswerCorrectionLog = [];
        }

        user.scorePathAnswerCorrectionLog.push({
            id: randomUUID(),

            bankKey,

            previousAnswer,

            correctedAnswer,

            regraded,

            correctedAt: now()
        });

        writeDb(req.db);

        return res.json({
            correctAnswer:
                correctedAnswer,

            regraded,

            message:
                `수정된 정답을 저장했습니다. ` +
                `풀이 기록 ${regraded}건을 재채점했습니다.`
        });
    }
);


// =====================================
// 기존 문제은행 조회 API
// =====================================

app.get("/api/scorepath/problem-bank", requireAuth, (req, res) => {

    const user = req.currentUser;

    ensureUserShape(user);

    // 기존 문제를 삭제하거나 이동하지 않는다.
    const sources = [
        ["오답", user.notes || []],
        ["복습 완료", user.solvedNotes || []],
        ["휴지통", user.trashNotes || []]
    ];

    const bank = new Map();

    let totalRecords = 0;

    for (const [source, records] of sources) {

        for (const note of records) {

            totalRecords++;

            const subject =
                safeText(note.subject);

            const problem =
                safeText(note.problem);

            const imageKey =
                safeText(note.problemImageKey);

            if (!problem && !imageKey) {
                continue;
            }

            // =====================================
            // 중복 문제 구분
            // =====================================

            // 내 답과 정답은 중복 판단에 사용하지 않는다.
            const normalizedText =
                problem
                    .replace(/\s+/g, " ")
                    .toLowerCase();

            // 문제 텍스트와 사진 키 기준
            const identity =
                JSON.stringify([
                    subject,
                    normalizedText,
                    imageKey
                ]);

            if (!bank.has(identity)) {

                bank.set(identity, {
                    subject,
                    problem,

                    problemImageKey:
                        imageKey,

                    unit:
                        safeText(note.unit),

                    sources: [],

                    correctAnswers: []
                });
            }

            const item =
                bank.get(identity);

            item.sources.push(source);

            if (!item.unit) {
                item.unit =
                    safeText(note.unit);
            }

            const answer =
                safeText(note.correctAnswer);

            if (
                answer &&
                !item.correctAnswers.includes(answer)
            ) {
                item.correctAnswers.push(answer);
            }
        }
    }

    return res.json({

        totalRecords,

        uniqueCount:
            bank.size,

               // =====================================
        // ScorePath 21-94
        // 사용자가 수정한 정답 우선 적용
        // =====================================

        items:
            [...bank.values()].map(
                (item, index) => {

                    const bankKey =
                        JSON.stringify([
                            item.subject,

                            safeText(item.problem)
                                .replace(/\s+/g, " ")
                                .toLowerCase(),

                            item.problemImageKey
                        ]);

                    const correctedAnswer =
                        safeText(
                            user.scorePathAnswerOverrides
                                ?.[bankKey]
                                ?.correctAnswer
                        );

                    return {
                        ...item,

                        id: index,

                        recordCount:
                            item.sources.length,

                        // 기존 정답 기록 보존
                        originalCorrectAnswers:
                            item.correctAnswers,

                        // 수정된 정답이 있으면 우선 사용
                        correctAnswers:
                            correctedAnswer
                                ? [correctedAnswer]
                                : item.correctAnswers,

                        correctAnswer:
                            correctedAnswer ||
                            (
                                item.correctAnswers.length === 1
                                    ? item.correctAnswers[0]
                                    : ""
                            ),

                        answerStatus:
                            correctedAnswer
                                ? "사용자 확인"
                                : item.correctAnswers.length === 1
                                    ? "기존 기록"
                                    : "정답 충돌"
                    };
                }
            )
    });
});


// -------------------------------------
// 시험 일정 조회
// -------------------------------------

app.get("/api/exams", requireAuth, (req, res) => {
    try {
        const user = req.currentUser;

        ensureUserShape(user);
        refreshWeaknessSystem(user);

        const currentTime = now();


        const exams =
            Object.values(
                user.examPlans || {}
            )
                .map((exam) => {

                    // =====================================
                    // 1. D-Day 계산
                    // =====================================

                    // =====================================
                    // ScorePath 21-39
                    // 날짜 기준 D-day 계산
                    // =====================================

                    const examTime =
                        new Date(
                            `${exam.examDate}T23:59:59`
                        ).getTime();

                    const today =
                        new Date(currentTime);

                    const examDate =
                        new Date(
                            `${exam.examDate}T00:00:00`
                        );

                    const todayUTC = Date.UTC(
                        today.getFullYear(),
                        today.getMonth(),
                        today.getDate()
                    );

                    const examUTC = Date.UTC(
                        examDate.getFullYear(),
                        examDate.getMonth(),
                        examDate.getDate()
                    );

                    const daysLeft =
                        Number.isFinite(examTime)
                            ? Math.round(
                                (examUTC - todayUTC) / 86400000
                            )
                            : null;


                    // =====================================
// 2. ScorePath 시험범위 기반 위험도
// =====================================

const riskProfile =
    buildExamRiskProfile(
        user,
        exam.subject,
        exam
    );


// =====================================
// 3. ScorePath 시험범위 측정 상태
// =====================================

const rangeStatus =
    buildExamRangeStatus(
        user,
        exam
    );


// =====================================
// 4. 시험 정보 반환
// =====================================

return {
    ...exam,

    daysLeft,

    isPast:
        Number.isFinite(
            examTime
        )
            ? examTime <
              currentTime
            : false,

        riskProfile,

    rangeStatus,

// ScorePath 19-1: 시험범위별 풀이 통계
unitStats: buildScorePathUnitStats(user, exam),

// ScorePath 21-2: 단원별 숙련도 추정
learningSignals: buildScorePathLearningSignalsV01(user, exam),

// ScorePath 21-6: 학습 우선순위 계산
studyPriorities: buildScorePathStudyPriorityV01(user, exam),

// ScorePath 21-9: 하루 학습시간 자동 배분
dailyStudyPlan: buildScorePathDailyStudyPlanV01(user, exam),

// =====================================
// ScorePath 21-73
// 학습 전광판 데이터 반환
// =====================================
learningBoard: buildScorePathLearningBoardV01(user, exam)
};
                })
                .sort(
                    (a, b) =>
                        String(
                            a.examDate
                        ).localeCompare(
                            String(
                                b.examDate
                            )
                        )
                );


        writeDb(req.db);


        return res.json({
            exams
        });

    } catch (error) {

        console.error(
            "EXAM LIST ERROR:",
            error
        );


        return res.status(500).json({
            error:
                "시험 일정을 불러오지 못했습니다."
        });
    }
});


// -------------------------------------
// 시험 일정 등록
// -------------------------------------

app.post("/api/exams", requireAuth, (req, res) => {
    try {
        const user = req.currentUser;

        ensureUserShape(user);

        // =====================================
        // 1. 기본 시험 정보
        // =====================================

        const name =
            safeText(req.body?.name);

        const subject =
            safeText(req.body?.subject);

        const examDate =
            safeText(req.body?.examDate);


        // =====================================
        // 2. ScorePath 시험 정보
        // =====================================

        const targetScore =
            Number(req.body?.targetScore);

        const dailyStudyMinutes =
            Number(req.body?.dailyStudyMinutes);

                // =====================================
        // ScorePath 21-18
        // 시험범위 + 단원별 중요도
        // =====================================

         // =====================================
        // ScorePath 21-220
        // 단원 중요도 + 선행 관계
        // =====================================

        const rawExamRange =
            Array.isArray(req.body?.examRange)
                ? req.body.examRange
                    .map(safeText)
                    .filter(Boolean)
                : [];

        const unitImportance =
            Object.create(null);

        const unitPrerequisites =
            Object.create(null);

        const examRange = [];

        // =====================================
        // 1. 시험범위 분석
        // =====================================

        for (const line of rawExamRange) {

            const parts =
                line.split("|").map(safeText);

            if (
                parts.length > 3 ||
                !parts[0] ||
                (
                    parts.length >= 2 &&
                    !/^[1-5]$/.test(parts[1])
                ) ||
                (
                    parts.length === 3 &&
                    !parts[2]
                )
            ) {

                return res.status(400).json({
                    error:
                        "시험범위 형식을 확인해 주세요. " +
                        "예: 도함수 | 4 | 미분계수"
                });
            }

            const unit = parts[0];

            // 중복 단원 방지
            if (examRange.includes(unit)) {

                return res.status(400).json({
                    error:
                        `시험범위에 '${unit}' 단원이 중복됐습니다.`
                });
            }

            const parents =
                parts.length === 3

                    ? parts[2]
                        .split(",")
                        .map(safeText)

                    : [];

            if (
                parents.some((parent) => !parent) ||
                new Set(parents).size !== parents.length
            ) {

                return res.status(400).json({
                    error:
                        `선행 단원 입력을 확인해 주세요: ${unit}`
                });
            }

            examRange.push(unit);

            // 설정하지 않으면 기본 중요도 3
            unitImportance[unit] =
                parts.length >= 2
                    ? Number(parts[1])
                    : 3;

            unitPrerequisites[unit] =
                parents;
        }

        // =====================================
        // 2. 선행 관계 검증
        // =====================================

        for (const unit of examRange) {

            for (
                const parent
                of unitPrerequisites[unit]
            ) {

                if (
                    parent === unit ||
                    !examRange.includes(parent)
                ) {

                    return res.status(400).json({
                        error:
                            `선행 단원 '${parent}'을(를) ` +
                            `확인해 주세요: ${unit}`
                    });
                }
            }
        }

        // =====================================
        // 3. 순환 관계 방지
        // =====================================

        const visitState = new Map();

        const hasCycle = (unit) => {

            const state =
                visitState.get(unit);

            if (state === 1) return true;
            if (state === 2) return false;

            visitState.set(unit, 1);

            for (
                const parent
                of unitPrerequisites[unit]
            ) {

                if (hasCycle(parent)) {
                    return true;
                }
            }

            visitState.set(unit, 2);

            return false;
        };

        if (examRange.some(hasCycle)) {

            return res.status(400).json({
                error:
                    "선행 관계가 서로 순환합니다. " +
                    "입력을 확인해 주세요."
            });
        }


        // =====================================
        // 3. 기본 정보 검증
        // =====================================

        if (!name) {
            return res.status(400).json({
                error:
                    "시험 이름을 입력해주세요."
            });
        }


        if (!subject) {
            return res.status(400).json({
                error:
                    "시험 과목을 선택해주세요."
            });
        }


        if (
            !Array.isArray(user.subjects) ||
            !user.subjects.includes(subject)
        ) {
            return res.status(400).json({
                error:
                    "등록되지 않은 과목입니다."
            });
        }


        // YYYY-MM-DD 형식 확인
        if (
            !/^\d{4}-\d{2}-\d{2}$/.test(
                examDate
            )
        ) {
            return res.status(400).json({
                error:
                    "시험 날짜를 올바르게 입력해주세요."
            });
        }


        const examTime =
            new Date(
                `${examDate}T23:59:59`
            ).getTime();


        if (!Number.isFinite(examTime)) {
            return res.status(400).json({
                error:
                    "시험 날짜를 확인해주세요."
            });
        }


        const currentTime = now();


        if (examTime < currentTime) {
            return res.status(400).json({
                error:
                    "이미 지난 시험은 등록할 수 없습니다."
            });
        }


        // =====================================
        // 4. ScorePath 정보 검증
        // =====================================

        if (
            !Number.isFinite(targetScore) ||
            targetScore < 0 ||
            targetScore > 100
        ) {
            return res.status(400).json({
                error:
                    "목표 점수는 0~100점 사이로 입력해주세요."
            });
        }


        if (
            !Number.isFinite(dailyStudyMinutes) ||
            dailyStudyMinutes <= 0 ||
            dailyStudyMinutes > 1440
        ) {
            return res.status(400).json({
                error:
                    "하루 공부 가능 시간을 올바르게 입력해주세요."
            });
        }


        if (examRange.length === 0) {
            return res.status(400).json({
                error:
                    "시험 범위를 하나 이상 입력해주세요."
            });
        }


         // =====================================
        // 5. 현재 성적 확인 및 시험 생성
        // =====================================

        // 미입력/기존 클라이언트는 '미측정'으로 저장
        const rawCurrentScore =
            req.body?.currentScore;

        const currentScoreMissing =
            rawCurrentScore == null ||
            String(rawCurrentScore).trim() === "";

        const currentScore =
            currentScoreMissing
                ? null
                : Number(rawCurrentScore);

        // 서버에서 다시 검증
        if (
            currentScore !== null &&
            (
                !Number.isFinite(currentScore) ||
                currentScore < 0 ||
                currentScore > 100
            )
        ) {

            return res.status(400).json({
                error:
                    "현재 성적은 0~100점으로 입력해 주세요."
            });
        }

        const id = randomUUID();


        const exam = {
            id,

            name,
            subject,
            examDate,

                       // ScorePath
            currentScore,
            targetScore,
            dailyStudyMinutes,
            examRange,
            unitImportance,
            unitPrerequisites,

            createdAt:
                currentTime,

            updatedAt:
                currentTime
        };


        // =====================================
        // 6. 저장
        // =====================================

        user.examPlans[id] = exam;

        writeDb(req.db);


        return res.json({
            message:
                "시험 일정이 등록되었습니다.",

            exam
        });

    } catch (error) {
        console.error(
            "EXAM CREATE ERROR:",
            error
        );

        return res.status(500).json({
            error:
                "시험 일정을 등록하지 못했습니다."
        });
    }
});


// =====================================
// ScorePath 21-19
// 기존 시험 단원 중요도 수정 API
// =====================================

app.patch("/api/exams/:examId/importance", requireAuth, (req, res) => {
    try {
        const user = req.currentUser;

        ensureUserShape(user);

        const examId =
            safeText(req.params.examId);

        const exam =
            user.examPlans?.[examId];

        if (!exam) {
            return res.status(404).json({
                error: "시험을 찾을 수 없습니다."
            });
        }

        const input =
            req.body?.unitImportance;

        if (
            !input ||
            typeof input !== "object" ||
            Array.isArray(input)
        ) {
            return res.status(400).json({
                error: "단원 중요도 정보가 올바르지 않습니다."
            });
        }

        const ranges =
            Array.isArray(exam.examRange)
                ? exam.examRange
                : [];

        const nextImportance =
            Object.create(null);

        for (const unit of ranges) {

            const rawValue =
                Object.prototype.hasOwnProperty.call(input, unit)
                    ? input[unit]
                    : exam.unitImportance?.[unit] ?? 3;

            const importance =
                Number(rawValue);

            if (
                !Number.isInteger(importance) ||
                importance < 1 ||
                importance > 5
            ) {
                return res.status(400).json({
                    error: `${unit} 단원의 중요도는 1~5 사이여야 합니다.`
                });
            }

            nextImportance[unit] =
                importance;
        }

        // 기존 시험 정보와 풀이 기록은 유지
        exam.unitImportance =
            nextImportance;

        exam.updatedAt =
            now();

        writeDb(req.db);

        return res.json({
            message: "단원 중요도가 수정되었습니다.",
            examId: exam.id,
            unitImportance: exam.unitImportance
        });

    } catch (error) {

        console.error(
            "SCOREPATH IMPORTANCE UPDATE ERROR:",
            error
        );

        return res.status(500).json({
            error: "단원 중요도를 수정하지 못했습니다."
        });
    }
});


// =====================================
// ScorePath 21-23
// 학습 시작 기록 API
// =====================================

app.post("/api/scorepath/study/start", requireAuth, (req, res) => {
    try {
        const user = req.currentUser;

        ensureUserShape(user);

        const examId =
            safeText(req.body?.examId);

        const unit =
            safeText(req.body?.unit);

        const exam =
            user.examPlans?.[examId];

        // 시험 및 단원 확인
        if (
            !exam ||
            !Array.isArray(exam.examRange) ||
            !exam.examRange.includes(unit)
        ) {
            return res.status(400).json({
                error: "시험 또는 학습 단원을 확인해주세요."
            });
        }

        // =====================================
        // ScorePath 21-289
        // 일반 공부 중 시험 공부 시작 방지
        // =====================================

        const activeGeneralStudy =
            Array.isArray(user.scorePathGeneralSessions)
                ? user.scorePathGeneralSessions.find(
                    item => item.status === "in_progress"
                )
                : null;

        if (activeGeneralStudy) {

            return res.status(409).json({

                code: "GENERAL_STUDY_ACTIVE",

                error:
                    `일반 공부 '${activeGeneralStudy.subject} · ${activeGeneralStudy.unit}'가 진행 중입니다. ` +
                    "먼저 일반 공부를 완료하거나 취소해주세요.",

                activeStudy: {

                    id: activeGeneralStudy.id,

                    subject: activeGeneralStudy.subject,

                    unit: activeGeneralStudy.unit
                }
            });
        }

        // =====================================
        // 기존 학습 기록 배열 준비
        // =====================================

        if (!Array.isArray(user.scorePathStudySessions)) {
            user.scorePathStudySessions = [];
        }

        // 이미 진행 중인 동일 학습이 있다면 재사용
        const existingSession =
            user.scorePathStudySessions.find((item) =>
                item.examId === examId &&
                item.unit === unit &&
                item.status === "in_progress"
            );

                if (existingSession) {
            return res.json({
                message: "진행 중인 학습을 불러왔습니다.",
                session: existingSession
            });
        }

        // =====================================
        // ScorePath 21-42
        // 동시 학습 기록 방지
        // =====================================

        const otherActiveSession =
            user.scorePathStudySessions.find((item) =>
                item.status === "in_progress"
            );

        if (otherActiveSession) {
            return res.status(409).json({
                error:
                    `현재 "${otherActiveSession.unit}" 학습이 진행 중입니다. ` +
                    "기존 학습을 완료한 후 새 학습을 시작해주세요."
            });
        }

        // 현재 추천 학습 계획
        const dailyPlan =
            buildScorePathDailyStudyPlanV01(user, exam);

        const recommendedSession =
            dailyPlan.sessions.find(
                (item) => item.unit === unit
            );

        if (!recommendedSession) {
            return res.status(400).json({
                error: "현재 추천 학습 계획에 없는 단원입니다."
            });
        }

        // 학습 시작 전 풀이 성적
        const unitStats =
            buildScorePathUnitStats(user, exam);

        const currentStats =
            unitStats.find(
                (item) => item.unit === unit
            );

        // 학습 기록 생성
        const session = {
            id: randomUUID(),

            examId,
            unit,

            plannedMinutes:
                recommendedSession.minutes,

            priorityScore:
                recommendedSession.priorityScore,

                        reason:
                recommendedSession.reason,

            // =====================================
            // ScorePath 21-99
            // 공부 시작 당시 추천 1순위 저장
            // =====================================

            recommendationAtStart:
                dailyPlan.sessions?.[0]
                    ? {
                        unit:
                            dailyPlan.sessions[0].unit,

                        activityTitle:
                            dailyPlan.sessions[0].activityTitle || ""
                    }
                    : null,

            // 학습 시작 전 기준
            baselineAttempts:
                currentStats?.attempts || 0,

                        baselineCorrect:
                currentStats?.correctCount || 0,

            // =====================================
            // ScorePath 21-66
            // 학습 시작 전 상태 저장
            // =====================================

            // 공부 시작 전 고유 문제 개수
            baselineUniqueAttempts:
                Number(currentStats?.uniqueAttempts) || 0,

            // 공부 시작 전 추정 숙련도
            baselineMastery:
                buildScorePathLearningSignalsV01(user, exam)
                    .find((item) => item.unit === unit)
                    ?.estimatedMastery ?? null,

            // 어떤 공부 활동을 추천받았는지 저장
            activityType:
                recommendedSession.activityType || "",

            activityTitle:
                recommendedSession.activityTitle || "",

            startedAt: now(),

            completedAt: null,

            actualMinutes: null,

            status: "in_progress"
        };

        // =====================================
        // ScorePath 21-337
        // 공부 시작부터 새 고유 문제 집계
        // =====================================

        // 공부 시작 시각을 검증 집계의
        // 시작 기준으로 사용한다.
        //
        // 정답 확인 후 저장된 새로운 문제는
        // 공부 완료 버튼을 누르기 전에도
        // 검증 개수에 반영할 수 있다.

        session.verificationStartedAt =
            Number(session.startedAt);

        user.scorePathStudySessions.push(session);

        writeDb(req.db);

        return res.json({
            message: "학습이 시작되었습니다.",
            session
        });

    } catch (error) {

        console.error(
            "SCOREPATH STUDY START ERROR:",
            error
        );

        return res.status(500).json({
            error: "학습 시작 기록을 저장하지 못했습니다."
        });
    }
});


// =====================================
// ScorePath 21-48
// 진행 중인 학습 취소 API
// =====================================

app.post("/api/scorepath/study/cancel", requireAuth, (req, res) => {
    try {
        const user = req.currentUser;

        ensureUserShape(user);

        const sessionId =
            safeText(req.body?.sessionId);

        if (!sessionId) {
            return res.status(400).json({
                error: "취소할 학습 기록을 선택해주세요."
            });
        }

        const sessions =
            Array.isArray(user.scorePathStudySessions)
                ? user.scorePathStudySessions
                : [];

        const activeSession = sessions.find(
            (item) =>
                item.id === sessionId &&
                item.status === "in_progress"
        );

        if (!activeSession) {
            return res.status(404).json({
                error: "진행 중인 학습을 찾을 수 없습니다."
            });
        }

        // 완료 기록과 구분해서 취소 처리
        activeSession.status = "cancelled";
        activeSession.cancelledAt = now();

        writeDb(req.db);

        return res.json({
            message: "학습이 취소되었습니다.",
            sessionId: activeSession.id
        });

    } catch (error) {

        console.error(
            "SCOREPATH STUDY CANCEL ERROR:",
            error
        );

        return res.status(500).json({
            error: "학습 취소에 실패했습니다."
        });
    }
});


// =====================================
// ScorePath 21-44
// 진행 중인 학습 조회 API
// =====================================

// =====================================
// ScorePath 21-331
// 시험 학습 후 검증: 공통 집계 함수
// =====================================

function getScorePathExamVerificationProgressV01(
    user,
    session,
    checkedAt = now()
) {
    const exam =
        user.examPlans?.[session.examId];

    const startedAt =
        Number(session.startedAt);

    const verificationStartedAt =
        Number(session.verificationStartedAt);

    const empty = {
        verificationRequired: false,
        freshProblemRecords: new Map(),
        excludedPreviouslySolved: 0,
        excludedRepeated: 0
    };

    if (
        !exam ||
        !Number.isFinite(startedAt) ||
        !Number.isFinite(verificationStartedAt) ||
        verificationStartedAt < startedAt ||
        verificationStartedAt <= 0
    ) {
        return empty;
    }

    const history =
        Array.isArray(user.problemHistory)
            ? user.problemHistory
            : [];

    const recordTime = (item) =>
        Number(
            item.solvedAt ||
            item.createdAt ||
            0
        );

    // 기존 완료 API의 고유 문제 식별 규칙 유지
    const problemKey = (item) => {

        const imageKey =
            safeText(item.problemImageKey);

        const problemText =
            safeText(item.problem)
                .replace(/\s+/g, " ")
                .toLowerCase();

        return imageKey
            ? `image:${imageKey}`
            : problemText
                ? `text:${problemText}`
                : `record:${safeText(item.id)}`;
    };

    const sameScope = (item) =>
        safeText(item.examId) ===
            safeText(session.examId) &&

        safeText(item.subject) ===
            safeText(exam.subject) &&

        safeText(item.unit) ===
            safeText(session.unit);

    // =====================================
    // 검증 시작 이전의 문제
    // =====================================

    const beforeKeys = new Set(

        history
            .filter((item) =>
                sameScope(item) &&
                recordTime(item) > 0 &&
                recordTime(item) <=
                    verificationStartedAt
            )
            .map(problemKey)

    );

    // =====================================
    // 검증 시작 이후의 새 고유 문제
    // =====================================

    const freshProblemRecords =
        new Map();

    let excludedPreviouslySolved = 0;
    let excludedRepeated = 0;

    for (const item of history) {

        const solvedAt =
            recordTime(item);

        if (
            !sameScope(item) ||
            solvedAt < startedAt ||
            solvedAt <= verificationStartedAt ||
            solvedAt > checkedAt
        ) {
            continue;
        }

        const key =
            problemKey(item);

        // 기존 문제 제외
        if (beforeKeys.has(key)) {

            excludedPreviouslySolved++;

            continue;
        }

        const previous =
            freshProblemRecords.get(key);

        // 검증 중 반복 문제
        if (previous) {
            excludedRepeated++;
        }

        // 해당 문제의 첫 풀이만 인정
        if (
            !previous ||
            solvedAt < recordTime(previous)
        ) {

            freshProblemRecords.set(
                key,
                item
            );
        }
    }

    return {
        verificationRequired: true,
        freshProblemRecords,
        excludedPreviouslySolved,
        excludedRepeated
    };
}

// =====================================
// 검증 진행 상태 조회 API
// =====================================

app.get(
    "/api/scorepath/study/verification-progress",
    requireAuth,
    (req, res) => {

        try {

            const user =
                req.currentUser;

            ensureUserShape(user);

            const activeSession =
                (user.scorePathStudySessions || [])
                    .find(
                        (item) =>
                            item.status === "in_progress"
                    );

            if (!activeSession) {

                return res.json({
                    active: false
                });
            }

            const progress =
                getScorePathExamVerificationProgressV01(
                    user,
                    activeSession
                );

            const checked =
                progress.freshProblemRecords.size;

            return res.json({

                active: true,

                sessionId:
                    activeSession.id,

                examId:
                    activeSession.examId,

                unit:
                    activeSession.unit,

                verificationRequired:
                    progress.verificationRequired,

                newUniqueAttempts:
                    checked,

                remainingProblems:
                    Math.max(0, 3 - checked),

                excludedPreviouslySolved:
                    progress.excludedPreviouslySolved,

                excludedRepeated:
                    progress.excludedRepeated
            });

        } catch (error) {

            console.error(
                "VERIFICATION PROGRESS ERROR:",
                error
            );

            return res.status(500).json({
                error:
                    "검증 진행 상태를 확인하지 못했습니다."
            });
        }
    }
);

// =====================================
// 기존 진행 중인 학습 조회 API
// =====================================

app.get("/api/scorepath/study/active", requireAuth, (req, res) => {
    try {
        const user =
            req.currentUser;

        ensureUserShape(user);

        const sessions =
            Array.isArray(user.scorePathStudySessions)
                ? user.scorePathStudySessions
                : [];

        const activeSession =
            sessions.find((item) =>
                item.status === "in_progress"
            ) || null;

        if (!activeSession) {
            return res.json({
                active: false,
                session: null
            });
        }

        const elapsedMinutes =
            Math.max(
                0,
                Math.round(
                    (
                        now() -
                        Number(activeSession.startedAt || now())
                    ) / 6000
                ) / 10
            );

        return res.json({
            active: true,

            session: {
                id: activeSession.id,
                examId: activeSession.examId,
                unit: activeSession.unit,

                plannedMinutes:
                    activeSession.plannedMinutes,

                startedAt:
                    activeSession.startedAt,

                elapsedMinutes
            }
        });

    } catch (error) {

        console.error(
            "SCOREPATH ACTIVE STUDY ERROR:",
            error
        );

        return res.status(500).json({
            error:
                "진행 중인 학습을 조회하지 못했습니다."
        });
    }
});


// =====================================
// ScorePath 21-25
// 학습 완료 + 학습 결과 기록 API
// =====================================

app.post("/api/scorepath/study/complete", requireAuth, (req, res) => {
    try {
        const user = req.currentUser;

        ensureUserShape(user);

        const examId =
            safeText(req.body?.examId);

        const unit =
            safeText(req.body?.unit);

        const exam =
            user.examPlans?.[examId];

        if (
            !exam ||
            !Array.isArray(exam.examRange) ||
            !exam.examRange.includes(unit)
        ) {
            return res.status(400).json({
                error: "시험 또는 단원을 확인해주세요."
            });
        }

        const sessions =
            Array.isArray(user.scorePathStudySessions)
                ? user.scorePathStudySessions
                : [];

        // =====================================
        // ScorePath 21-145
        // 학습 세션 ID 검증
        // =====================================

        const sessionId =
            safeText(req.body?.sessionId);

        // 세션 ID가 전달되면 해당 기록을 정확히 선택
        // 기존 요청과의 호환성을 위해
        // ID가 없는 요청은 진행 중인 학습을 조회
        const session = sessionId

            ? sessions.find((item) =>

                item.id === sessionId &&

                item.examId === examId &&

                item.unit === unit
            )

            : sessions.find((item) =>

                item.examId === examId &&

                item.unit === unit &&

                item.status === "in_progress"
            );

        if (!session) {

            return res.status(404).json({

                error:
                    "진행 중인 학습 기록이 없습니다."
            });
        }

        // =====================================
        // 이미 완료된 학습
        // =====================================

        if (
            session.status === "completed"
        ) {

            // 결과를 재계산하거나 다시 저장하지 않는다.
            // 기존에 저장된 결과를 그대로 반환한다.
            return res.json({

                message:
                    "이미 완료된 학습입니다.",

                alreadyCompleted: true,

                session
            });
        }

        // =====================================
        // 완료 가능한 상태인지 확인
        // =====================================

        if (
            session.status !== "in_progress"
        ) {

            return res.status(409).json({

                error:
                    "완료할 수 없는 학습 상태입니다."
            });
        }

        // =====================================
        // 1. 학습 경과시간 계산
        // =====================================

                // =====================================
        // ScorePath 21-43
        // 학습시간 데이터 검증
        // =====================================

        const completedAt =
            now();

        const startedAt =
            Number(session.startedAt);

        // 시작 시각 유효성 검사
        if (
            !Number.isFinite(startedAt) ||
            startedAt <= 0 ||
            startedAt > completedAt
        ) {
            return res.status(400).json({
                error:
                    "학습 시작 시각이 올바르지 않습니다."
            });
        }

        // 학습 경과시간 계산
        const elapsedMinutes =
            Math.round(
                ((completedAt - startedAt) / 60000) * 10
            ) / 10;

        // =====================================
        // ScorePath 21-325
        // 학습 종료 후 검증 단계 별도 시작
        // =====================================

        // 첫 완료 요청은 학습 종료 및 검증 시작을 뜻한다.
        // 그 이전 문제는 학습 후 검증 문제로 계산하지 않는다.
         // =====================================
        // ScorePath 21-338
        // 공부 완료 시 기존 문제 개수 유지
        // =====================================

        let verificationStartedAt =
            Number(session.verificationStartedAt);

        // 이전 버전에서 시작한 학습 세션도
        // 누적 기록을 잃지 않도록 보호한다.
        if (
            !Number.isFinite(verificationStartedAt) ||
            verificationStartedAt <= 0
        ) {

            verificationStartedAt =
                startedAt;

            session.verificationStartedAt =
                startedAt;

            writeDb(req.db);
        }

        if (
            verificationStartedAt < startedAt ||
            verificationStartedAt > completedAt
        ) {
            return res.status(409).json({
                error: "학습 후 검증 시작 시각을 확인할 수 없습니다."
            });
        }

        // =====================================
        // 2. 학습 완료 시점의 풀이 기록
        // =====================================

        const unitStats =
            buildScorePathUnitStats(user, exam);

        const currentStats =
            unitStats.find(
                (item) => item.unit === unit
            );

        const totalAttempts =
            currentStats?.attempts || 0;

        const totalCorrect =
            currentStats?.correctCount || 0;

        // =====================================
        // 3. 학습 중 새로 푼 문제 계산
        // =====================================

        // =====================================
        // ScorePath 21-69
        // 실제 학습 구간의 문제 풀이 기록
        // =====================================

        const problemHistory =
            Array.isArray(user.problemHistory)
                ? user.problemHistory
                : [];

        // 학습 시작부터 완료까지
        // 해당 시험·과목·단원에서 푼 문제만 선택
        const sessionRecords =
            problemHistory.filter((item) => {

                const solvedAt =
                    Number(
                        item.solvedAt ||
                        item.createdAt ||
                        0
                    );

                return (
                    safeText(item.examId) === examId &&
                    safeText(item.subject) ===
                        safeText(exam.subject) &&
                    safeText(item.unit) === unit &&
                    solvedAt >= startedAt &&
                    solvedAt <= completedAt
                );
            });

        const newAttempts =
            sessionRecords.length;

        const newCorrect =
            sessionRecords.filter(
                (item) =>
                    item.isCorrect === true
            ).length;

        const newWrong =
            newAttempts - newCorrect;

        const sessionAccuracy =
            newAttempts > 0
                ? Math.round(
                    (newCorrect / newAttempts) * 100
                )
                : null;

        // =====================================
        // ScorePath 21-249
        // 학습 결과 검증 전에는 완료 상태를 변경하지 않음
        // =====================================

                // =====================================
        // ScorePath 21-67
        // 학습 전후 숙련도 추정치 비교
        // =====================================

        // 학습 완료 후 숙련도 재계산
        const postSignal =
            buildScorePathLearningSignalsV01(user, exam)
                .find((item) => item.unit === unit);

        // 새롭게 확보한 고유 문제 개수
                // =====================================
        // ScorePath 21-70
        // 학습 세션의 새로운 고유 문제 계산
        // =====================================

        // =====================================
        // ScorePath 21-332
        // 완료 판단과 실시간 표시의 집계 규칙 통일
        // =====================================

        const verificationProgress =
            getScorePathExamVerificationProgressV01(
                user,
                session,
                completedAt
            );

        const freshProblemRecords =
            verificationProgress.freshProblemRecords;

        const newUniqueAttempts =
            freshProblemRecords.size;

        // =====================================
        // ScorePath 21-250
        // 새로운 문제 3개로 학습 후 확인
        // =====================================

        if (newUniqueAttempts < 3) {

            const remaining =
                3 - newUniqueAttempts;

            return res.status(409).json({

                error:
                    `공부 완료 전 새로운 문제 ${remaining}개를 ` +
                    "더 풀고 정답을 확인해 주세요. " +
                    "같은 문제의 재풀이는 개수에 포함되지 않습니다.",

                verificationRequired: true,

                newUniqueAttempts,

                remainingProblems: remaining

            });
        }

        const shortCheckCorrect =
            [...freshProblemRecords.values()]
                .filter((item) => item.isCorrect === true)
                .length;
        const shortCheckAccuracy =
            newUniqueAttempts > 0
                ? Math.round(
                    shortCheckCorrect / newUniqueAttempts * 100
                )
                : null;

        // =====================================
        // ScorePath 21-234
        // 새 문제 첫 풀이의 난이도별 성과
        // =====================================

        const freshDifficultyLevels =
            ["쉬움", "보통", "어려움"];

        const freshFirstRecords =
            [...freshProblemRecords.values()];

        const freshDifficultyStats =
            Object.fromEntries(

                freshDifficultyLevels.map((level) => {

                    const matching =
                        freshFirstRecords.filter(
                            (record) =>
                                safeText(record.difficulty) === level
                        );

                    const correct =
                        matching.filter(
                            (record) =>
                                record.isCorrect === true
                        ).length;

                    return [
                        level,
                        {
                            attempts: matching.length,

                            correctCount: correct,

                            accuracy: matching.length
                                ? Math.round(
                                    correct / matching.length * 100
                                )
                                : null
                        }
                    ];
                })
            );

        // 난이도 정보가 없는 문제는
        // 임의로 쉬움·보통·어려움에 배정하지 않는다.

        const freshDifficultyUnknownCount =
            freshFirstRecords.filter(
                (record) =>
                    !freshDifficultyLevels.includes(
                        safeText(record.difficulty)
                    )
            ).length;

        // 3문제는 간단한 확인용 기준일 뿐,
        // 실제 실력이나 성적을 보증하지 않는다.
        const shortCheckStatus =
            newUniqueAttempts === 0
                ? "not_started"
                : newUniqueAttempts < 3
                    ? "insufficient"
                    : shortCheckAccuracy < 70
                        ? "review_needed"
                        : "checked";

        const beforeMastery =
            session.baselineMastery;

        const afterMastery =
            postSignal?.estimatedMastery ?? null;

        // 최소한의 비교 조건
        const canCompareMastery =
            newUniqueAttempts >= 5 &&
            typeof beforeMastery === "number" &&
            Number.isFinite(beforeMastery) &&
            typeof afterMastery === "number" &&
            Number.isFinite(afterMastery);

        // =====================================
        // ScorePath 21-251
        // 검증 통과 후에만 학습 완료 확정
        // =====================================

        session.completedAt =
            completedAt;

        session.actualMinutes =
            elapsedMinutes;

        session.status =
            "completed";

        // =====================================
        // 학습 결과 저장
        // =====================================

        session.results = {
            attempts: newAttempts,
            correctCount: newCorrect,
            wrongCount: newWrong,
            accuracy: sessionAccuracy,

            // 새 고유 문제 개수
            newUniqueAttempts,

            // 학습 전후 추정 숙련도
            estimatedMasteryBefore:
                canCompareMastery
                    ? beforeMastery
                    : null,

            estimatedMasteryAfter:
                canCompareMastery
                    ? afterMastery
                    : null,

                        // 추정 숙련도 변화(%p)
            estimatedMasteryChangePp:
                canCompareMastery
                    ? afterMastery - beforeMastery
                    : null,

            // =====================================
            // ScorePath 21-112
            // 학습 후 간이 확인 결과
            // =====================================
            shortVerification: {
                status: shortCheckStatus,
                newProblems: newUniqueAttempts,
                correctCount: shortCheckCorrect,
                accuracy: shortCheckAccuracy,

                // =====================================
                // ScorePath 21-235
                // 난이도별 첫 풀이 결과 저장
                // =====================================

                difficultyStats:
                    freshDifficultyStats,

                difficultyUnknownCount:
                    freshDifficultyUnknownCount,

                suggestedMinimum: 3,
                remainingProblems:
                    Math.max(0, 3 - newUniqueAttempts)
            }
        };

        // 학습 완료 결과가 반영된 다음 추천을
        // 그 시점의 기록으로 남긴다.
        const updatedPlan =
            buildScorePathDailyStudyPlanV01(user, exam);

        const nextSession =
            updatedPlan.sessions?.[0] || null;

        // =====================================
        // ScorePath 21-253
        // 다음 추천의 판단 근거 저장
        // =====================================

        session.recommendationAfterComplete = nextSession
            ? {
                unit: nextSession.unit,

                minutes: nextSession.minutes,

                activityTitle:
                    nextSession.activityTitle || "학습 진행",

                reason:
                    nextSession.reason || ""
            }
            : null;

        writeDb(req.db);

        return res.json({
            message: "학습이 완료되었습니다.",
            session
        });

    } catch (error) {

        console.error(
            "SCOREPATH STUDY COMPLETE ERROR:",
            error
        );

        return res.status(500).json({
            error: "학습 완료 기록을 저장하지 못했습니다."
        });
    }
});


// =====================================
// ScorePath 21-27
// 누적 학습 기록 분석 API
// =====================================

app.get("/api/scorepath/study/history", requireAuth, (req, res) => {
    try {
        const user = req.currentUser;

        ensureUserShape(user);

        const examId =
            safeText(req.query.examId);

        const exam =
            user.examPlans?.[examId];

        if (!exam) {
            return res.status(404).json({
                error: "시험을 찾을 수 없습니다."
            });
        }

        const sessions = (
            Array.isArray(user.scorePathStudySessions)
                ? user.scorePathStudySessions
                : []
        )
            .filter((item) =>
                item.examId === examId &&
                item.status === "completed"
            )
            .sort((a, b) =>
                Number(b.completedAt || 0) -
                Number(a.completedAt || 0)
            );

        // 학습 기록 집계
        function summarize(items) {

            const totalMinutes = items.reduce(
                (sum, item) =>
                    sum + (Number(item.actualMinutes) || 0),
                0
            );

            const attempts = items.reduce(
                (sum, item) =>
                    sum + (Number(item.results?.attempts) || 0),
                0
            );

            const correctCount = items.reduce(
                (sum, item) =>
                    sum + (Number(item.results?.correctCount) || 0),
                0
            );

            return {
                completedSessions: items.length,

                totalMinutes:
                    Math.round(totalMinutes * 10) / 10,

                attempts,
                correctCount,

                wrongCount:
                    Math.max(0, attempts - correctCount),

                accuracy:
                    attempts > 0
                        ? Math.round(correctCount / attempts * 1000) / 10
                        : null
            };
        }

        const totals =
            summarize(sessions);

        // =====================================
        // ScorePath 21-33: 학습 전후 진단 비교
        // =====================================
        const completedDiagnoses = Object.values(
            user.examDiagnosisAttempts || {}
        ).filter((item) =>
            item.examId === examId &&
            item.status === "completed"
        );

        const unitStats = (
            Array.isArray(exam.examRange)
                ? exam.examRange
                : []
        ).map((unit) => {
            const unitSessions = sessions.filter(
                (item) => item.unit === unit
            );

            // 기존 21-30: 최근 학습 회차 정답률 비교
            const measuredSessions = unitSessions.filter(
                (item) =>
                    Number(item.results?.attempts) >= 5 &&
                    item.results?.accuracy != null &&
                    Number.isFinite(Number(item.results.accuracy))
            );

            const latest = measuredSessions[0] || null;
            const previous = measuredSessions[1] || null;

            const recentAccuracy = latest
                ? Number(latest.results.accuracy)
                : null;

            const previousAccuracy = previous
                ? Number(previous.results.accuracy)
                : null;

            const accuracyChange =
                recentAccuracy !== null && previousAccuracy !== null
                    ? Math.round((recentAccuracy - previousAccuracy) * 10) / 10
                    : null;

            // 학습 전 완료된 진단과 마지막 학습 후 시작한 재진단
            const startedTimes = unitSessions
                .map((item) => Number(item.startedAt))
                .filter((value) => Number.isFinite(value) && value > 0);

            const completedTimes = unitSessions
                .map((item) => Number(item.completedAt))
                .filter((value) => Number.isFinite(value) && value > 0);

            const firstStudyAt = startedTimes.length
                ? Math.min(...startedTimes)
                : null;

            const lastStudyAt = completedTimes.length
                ? Math.max(...completedTimes)
                : null;

            const diagnosesForUnit = completedDiagnoses.filter(
                (item) => item.rangeName === unit
            );

            const before = firstStudyAt === null
                ? null
                : diagnosesForUnit
                    .filter((item) =>
                        Number(item.completedAt) > 0 &&
                        Number(item.completedAt) < firstStudyAt
                    )
                    .sort((a, b) =>
                        Number(b.completedAt) - Number(a.completedAt)
                    )[0] || null;

            const after = lastStudyAt === null
                ? null
                : diagnosesForUnit
                    .filter((item) =>
                        Number(item.startedAt) >= lastStudyAt &&
                        Number(item.completedAt) > 0
                    )
                    .sort((a, b) =>
                        Number(b.completedAt) - Number(a.completedAt)
                    )[0] || null;

            const signature = (attempt) =>
                (Array.isArray(attempt?.answers) ? attempt.answers : [])
                    .map((answer) =>
                        `${answer.role}:${answer.difficulty}`
                    )
                    .join("|");

            // 같은 역할·난이도 라벨일 때만 참고용 변화량 표시
            const comparable = Boolean(before && after) &&
                before.answers?.length === 3 &&
                after.answers?.length === 3 &&
                signature(before) === signature(after);

            const beforeAccuracy = before
                ? Math.round(Number(before.correctCount || 0) / 3 * 1000) / 10
                : null;

            const afterAccuracy = after
                ? Math.round(Number(after.correctCount || 0) / 3 * 1000) / 10
                : null;

            const changePp = comparable
                ? Math.round((afterAccuracy - beforeAccuracy) * 10) / 10
                : null;

            return {
                unit,
                ...summarize(unitSessions),
                recentAccuracy,
                previousAccuracy,
                accuracyChange,
                measuredSessions: measuredSessions.length,
                diagnosisComparison: {
                    status: !before || !after
                        ? "insufficient"
                        : comparable
                            ? "comparable"
                            : "not_comparable",
                    beforeAccuracy,
                    afterAccuracy,
                    changePp,
                    beforeAt: before?.completedAt || null,
                    afterAt: after?.completedAt || null
                }
            };
        });

        return res.json({
            examId,

            summary: {
                completedSessions: totals.completedSessions,
                totalMinutes: totals.totalMinutes,
                totalAttempts: totals.attempts,
                totalCorrect: totals.correctCount,
                totalWrong: totals.wrongCount,
                accuracy: totals.accuracy
            },

            unitStats,
            sessions
        });

    } catch (error) {

        console.error(
            "SCOREPATH STUDY HISTORY ERROR:",
            error
        );

        return res.status(500).json({
            error: "학습 기록을 불러오지 못했습니다."
        });
    }
});


// -------------------------------------
// 시험 일정 삭제
// -------------------------------------

app.delete("/api/exams/:examId", requireAuth, (req, res) => {
    try {
        const user = req.currentUser;

        ensureUserShape(user);

        const examId =
            safeText(req.params.examId);


        if (
            !examId ||
            !user.examPlans[examId]
        ) {
            return res.status(404).json({
                error:
                    "시험 일정을 찾을 수 없습니다."
            });
        }


        delete user.examPlans[examId];

        writeDb(req.db);


        return res.json({
            message:
                "시험 일정이 삭제되었습니다."
        });

    } catch (error) {
        console.error(
            "EXAM DELETE ERROR:",
            error
        );

        return res.status(500).json({
            error:
                "시험 일정을 삭제하지 못했습니다."
        });
    }
});

// =====================================
// 7-3 ScorePath 시험범위 진단 시작
// =====================================

app.post(
    "/api/exams/:examId/diagnosis/start",
    requireAuth,
    async (req, res) => {
        try {
            const user =
                req.currentUser;

            ensureUserShape(user);


            // =====================================
            // 1. 시험 확인
            // =====================================

            const examId =
                safeText(
                    req.params.examId
                );

            const exam =
                user.examPlans?.[
                    examId
                ];


            if (!exam) {
                return res
                    .status(404)
                    .json({
                        error:
                            "시험 일정을 찾을 수 없습니다."
                    });
            }


            // =====================================
            // 2. 진단할 시험범위 확인
            // =====================================

            const rangeName =
                normalizeWeaknessLabel(
                    req.body?.rangeName
                );


            if (!rangeName) {
                return res
                    .status(400)
                    .json({
                        error:
                            "진단할 시험범위를 선택해주세요."
                    });
            }


            const examRange =
                Array.isArray(
                    exam.examRange
                )
                    ? exam.examRange
                        .map((item) =>
                            normalizeWeaknessLabel(
                                item
                            )
                        )
                        .filter(Boolean)
                    : [];


            const matchedRange =
                examRange.find(
                    (item) =>
                        item === rangeName
                );


            if (!matchedRange) {
                return res
                    .status(400)
                    .json({
                        error:
                            "등록된 시험범위가 아닙니다."
                    });
            }


            // =====================================
            // 3. 현재 범위 측정 상태 확인
            // =====================================

            const rangeStatus =
                buildExamRangeStatus(
                    user,
                    exam
                );


            const targetRangeStatus =
                (
                    Array.isArray(
                        rangeStatus?.ranges
                    )
                        ? rangeStatus.ranges
                        : []
                ).find(
                    (item) =>
                        normalizeWeaknessLabel(
                            item.rangeName
                        ) ===
                        matchedRange
                );


            if (!targetRangeStatus) {
                return res
                    .status(400)
                    .json({
                        error:
                            "시험범위 상태를 확인하지 못했습니다."
                    });
            }


            // =====================================
            // 4. 이미 진행 중인 같은 범위 진단 확인
            // =====================================

            const activeAttempt =
                Object.values(
                    user.examDiagnosisAttempts ||
                    {}
                ).find(
                    (attempt) =>
                        safeText(
                            attempt?.examId
                        ) === examId &&

                        normalizeWeaknessLabel(
                            attempt?.rangeName
                        ) ===
                            matchedRange &&

                        safeText(
                            attempt?.status
                        ) === "active"
                );


            if (activeAttempt) {

                const activeProblems =
                    Array.isArray(
                        activeAttempt.problems
                    )
                        ? activeAttempt.problems
                        : [];

                const currentIndex =
                    Math.max(
                        0,
                        Number(
                            activeAttempt.currentIndex ||
                            0
                        )
                    );

                const currentProblem =
                    activeProblems[
                        currentIndex
                    ] || null;


                return res.json({
                    reused: true,

                    message:
                        "진행 중인 진단을 이어서 시작합니다.",

                    attempt: {
                        id:
                            activeAttempt.id,

                        examId:
                            activeAttempt.examId,

                        examName:
                            activeAttempt.examName,

                        subject:
                            activeAttempt.subject,

                        rangeName:
                            activeAttempt.rangeName,

                        status:
                            activeAttempt.status,

                        currentIndex,

                        correctCount:
                            Number(
                                activeAttempt.correctCount ||
                                0
                            ),

                        wrongCount:
                            Number(
                                activeAttempt.wrongCount ||
                                0
                            ),

                        problemCount:
                            activeProblems.length,

                        startedAt:
                            activeAttempt.startedAt
                    },

                    currentProblem:
                        currentProblem
                            ? {
                                id:
                                    currentProblem.id,

                                role:
                                    currentProblem.role,

                                difficulty:
                                    currentProblem.difficulty,

                                problem:
                                    currentProblem.problem
                            }
                            : null,

                    rangeStatus:
                        targetRangeStatus
                });
            }


            // =====================================
            // 5. 진단 문제 3개 생성
            // =====================================

            const problems =
                await generateExamDiagnosisProblems(
                    exam.subject,
                    matchedRange
                );


            if (
                !Array.isArray(problems) ||
                problems.length !== 3
            ) {
                throw new Error(
                    "진단 문제 생성 결과가 올바르지 않습니다."
                );
            }


            // =====================================
            // 6. 새 진단 기록 생성
            // =====================================

            const attemptId =
                randomUUID();

            const currentTime =
                now();


            const attempt = {
                id:
                    attemptId,

                examId:
                    exam.id,

                examName:
                    safeText(
                        exam.name
                    ),

                subject:
                    safeText(
                        exam.subject
                    ),

                rangeName:
                    matchedRange,

                status:
                    "active",

                problems,

                answers:
                    [],

                currentIndex:
                    0,

                correctCount:
                    0,

                wrongCount:
                    0,

                startedAt:
                    currentTime,

                updatedAt:
                    currentTime,

                completedAt:
                    null
            };


            // =====================================
            // 7. 저장
            // =====================================

            user.examDiagnosisAttempts[
                attemptId
            ] = attempt;


            writeDb(req.db);


            // =====================================
            // 8. 첫 번째 문제만 클라이언트에 전달
            // =====================================

            const firstProblem =
                problems[0];


            return res.json({
                reused: false,

                message:
                    "시험범위 진단이 시작되었습니다.",

                attempt: {
                    id:
                        attempt.id,

                    examId:
                        attempt.examId,

                    examName:
                        attempt.examName,

                    subject:
                        attempt.subject,

                    rangeName:
                        attempt.rangeName,

                    status:
                        attempt.status,

                    currentIndex:
                        attempt.currentIndex,

                    correctCount:
                        attempt.correctCount,

                    wrongCount:
                        attempt.wrongCount,

                    problemCount:
                        problems.length,

                    startedAt:
                        attempt.startedAt
                },

                currentProblem: {
                    id:
                        firstProblem.id,

                    role:
                        firstProblem.role,

                    difficulty:
                        firstProblem.difficulty,

                    problem:
                        firstProblem.problem
                },

                rangeStatus:
                    targetRangeStatus
            });

        } catch (error) {
            console.error(
                "EXAM DIAGNOSIS START ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        error?.message ||
                        "시험범위 진단을 시작하지 못했습니다."
                });
        }
    }
);

// =====================================
// 7-3-1 ScorePath 시험범위 진단 답안 제출
// =====================================

app.post(
    "/api/exams/:examId/diagnosis/:attemptId/answer",
    requireAuth,
    (req, res) => {
        try {
            const user =
                req.currentUser;

            ensureUserShape(user);


            // =====================================
            // 1. 시험 확인
            // =====================================

            const examId =
                safeText(
                    req.params.examId
                );

            const exam =
                user.examPlans?.[
                    examId
                ];


            if (!exam) {
                return res
                    .status(404)
                    .json({
                        error:
                            "시험 일정을 찾을 수 없습니다."
                    });
            }


            // =====================================
            // 2. 진단 기록 확인
            // =====================================

            const attemptId =
                safeText(
                    req.params.attemptId
                );

            const attempt =
                user.examDiagnosisAttempts?.[
                    attemptId
                ];


            if (
                !attempt ||
                safeText(
                    attempt.examId
                ) !== examId
            ) {
                return res
                    .status(404)
                    .json({
                        error:
                            "진단 기록을 찾을 수 없습니다."
                    });
            }


            if (
                safeText(
                    attempt.status
                ) !== "active"
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "이미 완료된 진단입니다."
                    });
            }


            // =====================================
            // 3. 현재 문제 확인
            // =====================================

            const problems =
                Array.isArray(
                    attempt.problems
                )
                    ? attempt.problems
                    : [];


            if (problems.length !== 3) {
                return res
                    .status(400)
                    .json({
                        error:
                            "진단 문제 정보가 올바르지 않습니다."
                    });
            }


            const currentIndex =
                Math.max(
                    0,
                    Number(
                        attempt.currentIndex ||
                        0
                    )
                );


            if (
                currentIndex >=
                problems.length
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "더 이상 제출할 진단 문제가 없습니다."
                    });
            }


            const currentProblem =
                problems[
                    currentIndex
                ];


            // =====================================
            // 4. 사용자 답 확인
            // =====================================

            const userAnswer =
                safeText(
                    req.body?.answer
                );


            if (!userAnswer) {
                return res
                    .status(400)
                    .json({
                        error:
                            "답을 입력해주세요."
                    });
            }


            // =====================================
            // 5. 서버에서 정답 판정
            // =====================================

            const isCorrect =
                answersEquivalent(
                    userAnswer,
                    currentProblem.correctAnswer,
                    currentProblem.problem
                );


            const currentTime =
                now();


            if (
                !Array.isArray(
                    attempt.answers
                )
            ) {
                attempt.answers = [];
            }


            attempt.answers.push({
                problemId:
                    currentProblem.id,

                problemIndex:
                    currentIndex,

                role:
                    safeText(
                        currentProblem.role
                    ),

                difficulty:
                    safeText(
                        currentProblem.difficulty
                    ),

                userAnswer,

                isCorrect,

                answeredAt:
                    currentTime
            });


            if (isCorrect) {
                attempt.correctCount =
                    Number(
                        attempt.correctCount ||
                        0
                    ) + 1;
            } else {
                attempt.wrongCount =
                    Number(
                        attempt.wrongCount ||
                        0
                    ) + 1;
            }


            attempt.currentIndex =
                currentIndex + 1;

            attempt.updatedAt =
                currentTime;


            // =====================================
            // 6. 3문제 완료 여부
            // =====================================

            const completed =
                attempt.currentIndex >=
                problems.length;


            if (completed) {
                attempt.status =
                    "completed";

                attempt.completedAt =
                    currentTime;


                writeDb(req.db);


                return res.json({
                    completed: true,

                    result: {
                        isCorrect,

                        answeredProblemNumber:
                            currentIndex + 1
                    },

                    attempt: {
                        id:
                            attempt.id,

                        examId:
                            attempt.examId,

                        examName:
                            attempt.examName,

                        subject:
                            attempt.subject,

                        rangeName:
                            attempt.rangeName,

                        status:
                            attempt.status,

                        currentIndex:
                            attempt.currentIndex,

                        problemCount:
                            problems.length,

                        correctCount:
                            Number(
                                attempt.correctCount ||
                                0
                            ),

                        wrongCount:
                            Number(
                                attempt.wrongCount ||
                                0
                            ),

                        startedAt:
                            attempt.startedAt,

                        completedAt:
                            attempt.completedAt
                    },

                    nextProblem:
                        null
                });
            }


            // =====================================
            // 7. 다음 문제 반환
            // =====================================

            const nextProblem =
                problems[
                    attempt.currentIndex
                ];


            writeDb(req.db);


            return res.json({
                completed: false,

                result: {
                    isCorrect,

                    answeredProblemNumber:
                        currentIndex + 1
                },

                attempt: {
                    id:
                        attempt.id,

                    examId:
                        attempt.examId,

                    examName:
                        attempt.examName,

                    subject:
                        attempt.subject,

                    rangeName:
                        attempt.rangeName,

                    status:
                        attempt.status,

                    currentIndex:
                        attempt.currentIndex,

                    problemCount:
                        problems.length,

                    correctCount:
                        Number(
                            attempt.correctCount ||
                            0
                        ),

                    wrongCount:
                        Number(
                            attempt.wrongCount ||
                            0
                        ),

                    startedAt:
                        attempt.startedAt
                },

                nextProblem: {
                    id:
                        nextProblem.id,

                    role:
                        nextProblem.role,

                    difficulty:
                        nextProblem.difficulty,

                    problem:
                        nextProblem.problem
                }
            });

        } catch (error) {
            console.error(
                "EXAM DIAGNOSIS ANSWER ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "진단 답안을 처리하지 못했습니다."
                });
        }
    }
);

// =====================================
// 7-4 시험 대비 세트 조회
// =====================================

app.get(
    "/api/exams/:examId/study-set",
    requireAuth,
    (req, res) => {
        try {
            const user =
                req.currentUser;

            ensureUserShape(user);

            const examId =
                safeText(
                    req.params.examId
                );

            const exam =
                user.examPlans?.[examId];


            if (!exam) {
                return res
                    .status(404)
                    .json({
                        error:
                            "시험 일정을 찾을 수 없습니다."
                    });
            }


            const studySet =
                buildExamStudySet(
                    user,
                    exam
                );


            writeDb(req.db);


            return res.json({
                studySet
            });

        } catch (error) {
            console.error(
                "EXAM STUDY SET ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "시험 대비 세트를 만들지 못했습니다."
                });
        }
    }
);

// =====================================
// 7-4 시험 대비 풀이 시작
// =====================================

app.post(
    "/api/exams/:examId/study-attempt/start",
    requireAuth,
    (req, res) => {
        try {
            const user =
                req.currentUser;

            ensureUserShape(user);

            const examId =
                safeText(
                    req.params.examId
                );

            const exam =
                user.examPlans?.[examId];


            if (!exam) {
                return res
                    .status(404)
                    .json({
                        error:
                            "시험 일정을 찾을 수 없습니다."
                    });
            }


            // 이미 진행 중인 같은 시험 풀이가 있으면 재사용
            const activeAttempt =
                Object.values(
                    user.examStudyAttempts
                ).find(
                    (attempt) =>
                        safeText(
                            attempt.examId
                        ) === examId &&
                        safeText(
                            attempt.status
                        ) === "active"
                );


            if (activeAttempt) {
                const currentProblem =
                    activeAttempt.problems?.[
                        Number(
                            activeAttempt.currentIndex ||
                            0
                        )
                    ];


                return res.json({
                    reused: true,

                    attempt: {
                        id:
                            activeAttempt.id,

                        examId:
                            activeAttempt.examId,

                        examName:
                            activeAttempt.examName,

                        subject:
                            activeAttempt.subject,

                        status:
                            activeAttempt.status,

                        currentIndex:
                            activeAttempt.currentIndex,

                        totalCount:
                            activeAttempt.problems.length,

                        correctCount:
                            activeAttempt.correctCount,

                        wrongCount:
                            activeAttempt.wrongCount,

                        currentProblem:
                            currentProblem
                                ? {
                                    number:
                                        Number(
                                            activeAttempt.currentIndex
                                        ) + 1,

                                    problem:
                                        currentProblem.problem,

                                    unit:
                                        currentProblem.unit,

                                    weakConcept:
                                        currentProblem.weakConcept,

                                    problemType:
                                        currentProblem.problemType
                                }
                                : null
                    }
                });
            }


            const studySet =
                buildExamStudySet(
                    user,
                    exam
                );


            if (
                !Array.isArray(
                    studySet.problems
                ) ||
                studySet.problems.length === 0
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "시험 대비에 사용할 오답 문제가 없습니다."
                    });
            }


            const allNotes = [
                ...(Array.isArray(user.notes)
                    ? user.notes
                    : []),

                ...(Array.isArray(
                    user.solvedNotes
                )
                    ? user.solvedNotes
                    : [])
            ];


            const attemptProblems = [];


            for (
                const studyProblem of
                studySet.problems
            ) {
                const sourceNote =
                    allNotes.find(
                        (note) =>
                            safeText(note.id) ===
                            safeText(
                                studyProblem.noteId
                            )
                    );


                if (!sourceNote) {
                    continue;
                }


                const correctAnswer =
                    safeText(
                        sourceNote.correctAnswer
                    );


                if (!correctAnswer) {
                    continue;
                }


                attemptProblems.push({
                    noteId:
                        safeText(
                            sourceNote.id
                        ),

                    weaknessKey:
                        getWeaknessKey(
                            sourceNote
                        ).key,

                    subject:
                        safeText(
                            sourceNote.subject
                        ),

                    problem:
                        safeText(
                            sourceNote.problem
                        ),

                    // 서버 내부에만 보관
                    correctAnswer,

                    unit:
                        safeText(
                            sourceNote.unit
                        ),

                    weakConcept:
                        safeText(
                            sourceNote.weakConcept
                        ),

                    weakConceptDetail:
                        safeText(
                            sourceNote.weakConceptDetail
                        ),

                    problemType:
                        safeText(
                            sourceNote.problemType
                        ),

                    difficulty:
                        safeText(
                            sourceNote.difficulty
                        ),

                    result: null,
                    userAnswer: "",
                    answeredAt: null
                });
            }


            if (
                attemptProblems.length === 0
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "채점 가능한 시험 대비 문제가 없습니다."
                    });
            }


            const attemptId =
                randomUUID();

            const currentTime =
                now();


            const attempt = {
                id:
                    attemptId,

                examId,

                examName:
                    safeText(exam.name),

                subject:
                    safeText(exam.subject),

                examDate:
                    safeText(exam.examDate),

                status:
                    "active",

                problems:
                    attemptProblems,

                currentIndex:
                    0,

                correctCount:
                    0,

                wrongCount:
                    0,

                startedAt:
                    currentTime,

                updatedAt:
                    currentTime,

                completedAt:
                    null
            };


            user.examStudyAttempts[
                attemptId
            ] = attempt;


            writeDb(req.db);


            const firstProblem =
                attemptProblems[0];


            // correctAnswer는 절대 응답하지 않는다.
            return res.json({
                reused: false,

                attempt: {
                    id:
                        attempt.id,

                    examId:
                        attempt.examId,

                    examName:
                        attempt.examName,

                    subject:
                        attempt.subject,

                    status:
                        attempt.status,

                    currentIndex:
                        0,

                    totalCount:
                        attempt.problems.length,

                    correctCount:
                        0,

                    wrongCount:
                        0,

                    currentProblem: {
                        number:
                            1,

                        problem:
                            firstProblem.problem,

                        unit:
                            firstProblem.unit,

                        weakConcept:
                            firstProblem.weakConcept,

                        problemType:
                            firstProblem.problemType
                    }
                }
            });

        } catch (error) {
            console.error(
                "EXAM STUDY ATTEMPT START ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "시험 대비 풀이를 시작하지 못했습니다."
                });
        }
    }
);

// =====================================
// 7-4-2 시험 대비 문제 채점
// =====================================

app.post(
    "/api/exams/study-attempt/check",
    requireAuth,
    (req, res) => {
        try {
            const user =
                req.currentUser;

            ensureUserShape(user);


            const attemptId =
                safeText(
                    req.body?.attemptId
                );

            const userAnswer =
                safeText(
                    req.body?.userAnswer
                );


            if (!attemptId) {
                return res
                    .status(400)
                    .json({
                        error:
                            "시험 대비 풀이 정보를 찾을 수 없습니다."
                    });
            }


            if (!userAnswer) {
                return res
                    .status(400)
                    .json({
                        error:
                            "답을 입력해주세요."
                    });
            }


            const attempt =
                user.examStudyAttempts?.[
                    attemptId
                ];


            if (!attempt) {
                return res
                    .status(404)
                    .json({
                        error:
                            "시험 대비 풀이 기록을 찾을 수 없습니다."
                    });
            }


            // 이미 끝난 시험 세트
            if (
                attempt.status ===
                "completed"
            ) {
                return res.json({
                    duplicate: true,

                    completed: true,

                    message:
                        "이미 완료된 시험 대비 세트입니다.",

                    result: {
                        totalCount:
                            attempt.problems.length,

                        correctCount:
                            Number(
                                attempt.correctCount ||
                                0
                            ),

                        wrongCount:
                            Number(
                                attempt.wrongCount ||
                                0
                            ),

                        accuracy:
                            attempt.problems.length > 0
                                ? Math.round(
                                    (
                                        Number(
                                            attempt.correctCount ||
                                            0
                                        ) /
                                        attempt.problems.length
                                    ) * 100
                                )
                                : 0
                    }
                });
            }


            if (
                attempt.status !==
                "active"
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "현재 진행할 수 없는 시험 대비 세트입니다."
                    });
            }


            const currentIndex =
                Number(
                    attempt.currentIndex ||
                    0
                );


            const currentProblem =
                attempt.problems?.[
                    currentIndex
                ];


            if (!currentProblem) {
                return res
                    .status(400)
                    .json({
                        error:
                            "현재 풀 문제를 찾을 수 없습니다."
                    });
            }


            // 이미 처리된 문제라면
            // 중복 점수 반영 방지
            if (
                currentProblem.result ===
                    "correct" ||
                currentProblem.result ===
                    "wrong"
            ) {
                return res
                    .status(409)
                    .json({
                        error:
                            "이미 채점된 문제입니다."
                    });
            }


            const correctAnswer =
                safeText(
                    currentProblem.correctAnswer
                );

            const problem =
                safeText(
                    currentProblem.problem
                );


            if (
                !correctAnswer ||
                !problem
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "시험 대비 문제의 채점 정보를 찾을 수 없습니다."
                    });
            }


            // =====================================
            // 서버에서 정답 판정
            // =====================================

            const isCorrect =
                answersEquivalent(
                    userAnswer,
                    correctAnswer,
                    problem
                );


            const allNotes = [
                ...(Array.isArray(user.notes)
                    ? user.notes
                    : []),

                ...(Array.isArray(
                    user.solvedNotes
                )
                    ? user.solvedNotes
                    : [])
            ];


            const sourceNote =
                allNotes.find(
                    (note) =>
                        safeText(note.id) ===
                        safeText(
                            currentProblem.noteId
                        )
                );


            // =====================================
            // 학습 이벤트 기록
            //
            // 시험 대비 결과는 약점 점수에는 반영
            // 예약복습 stage는 직접 진행시키지 않는다.
            // =====================================

            if (sourceNote) {
                recordLearningEvent(
                    user,
                    sourceNote,

                    isCorrect
                        ? "correct"
                        : "wrong",

                    "exam_review",
                    "exam_review"
                );
            }


            // =====================================
            // 현재 문제 결과 저장
            // =====================================

            currentProblem.result =
                isCorrect
                    ? "correct"
                    : "wrong";

            currentProblem.userAnswer =
                userAnswer;

            currentProblem.answeredAt =
                now();


            if (isCorrect) {
                attempt.correctCount =
                    Number(
                        attempt.correctCount ||
                        0
                    ) + 1;

            } else {
                attempt.wrongCount =
                    Number(
                        attempt.wrongCount ||
                        0
                    ) + 1;
            }


            attempt.updatedAt =
                now();


            const nextIndex =
                currentIndex + 1;


            // =====================================
            // 마지막 문제까지 끝났는지 확인
            // =====================================

            const completed =
                nextIndex >=
                attempt.problems.length;


            if (completed) {
                attempt.status =
                    "completed";

                attempt.currentIndex =
                    attempt.problems.length;

                attempt.completedAt =
                    now();


                // 전체 시험 풀이 결과까지 반영한 뒤
                // 약점 프로필을 다시 계산
                refreshWeaknessSystem(
                    user
                );


                writeDb(req.db);


                const totalCount =
                    attempt.problems.length;

                const correctCount =
                    Number(
                        attempt.correctCount ||
                        0
                    );

                const wrongCount =
                    Number(
                        attempt.wrongCount ||
                        0
                    );


                const accuracy =
                    totalCount > 0
                        ? Math.round(
                            (
                                correctCount /
                                totalCount
                            ) * 100
                        )
                        : 0;


                return res.json({
                    duplicate: false,

                    isCorrect,

                    completed: true,

                    message:
                        isCorrect
                            ? "정답입니다! 시험 대비 세트를 모두 완료했습니다."
                            : "오답입니다. 시험 대비 세트를 모두 완료했습니다.",

                    answeredProblem: {
                        number:
                            currentIndex + 1,

                        problem,

                        // 채점이 끝난 현재 문제만
                        // 정답 공개
                        correctAnswer,

                        userAnswer
                    },

                    result: {
                        totalCount,
                        correctCount,
                        wrongCount,
                        accuracy
                    }
                });
            }


            // =====================================
            // 다음 문제로 이동
            // =====================================

            attempt.currentIndex =
                nextIndex;


            // 이번 결과도 즉시 약점 시스템에 반영
            refreshWeaknessSystem(
                user
            );


            writeDb(req.db);


            const nextProblem =
                attempt.problems[
                    nextIndex
                ];


            return res.json({
                duplicate: false,

                isCorrect,

                completed: false,

                message:
                    isCorrect
                        ? "정답입니다! 다음 문제로 넘어갑니다."
                        : "오답입니다. 정답을 확인하고 다음 문제로 넘어갑니다.",


                // 방금 채점한 문제만 정답 공개
                answeredProblem: {
                    number:
                        currentIndex + 1,

                    problem,

                    correctAnswer,

                    userAnswer
                },


                progress: {
                    current:
                        nextIndex + 1,

                    total:
                        attempt.problems.length,

                    correctCount:
                        Number(
                            attempt.correctCount ||
                            0
                        ),

                    wrongCount:
                        Number(
                            attempt.wrongCount ||
                            0
                        )
                },


                // 다음 문제에는 정답 없음
                nextProblem: {
                    number:
                        nextIndex + 1,

                    problem:
                        nextProblem.problem,

                    unit:
                        nextProblem.unit,

                    weakConcept:
                        nextProblem.weakConcept,

                    problemType:
                        nextProblem.problemType
                }
            });

        } catch (error) {
            console.error(
                "EXAM STUDY ATTEMPT CHECK ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "시험 대비 문제를 채점하지 못했습니다."
                });
        }
    }
);



// =====================================
// ScorePath 21-155
// 공개 서비스에서 테스트 API 차단
// =====================================

app.use(

    [
        "/api/plan/test-change",
        "/api/test/reset-usage"
    ],

    (req, res, next) => {

        // =====================================
        // 개발 환경에서만 테스트 허용
        // =====================================

        if (
            process.env.NODE_ENV !== "production" &&
            process.env.SCOREPATH_ENABLE_TEST_ENDPOINTS === "true"
        ) {

            return next();
        }

        // =====================================
        // 기본적으로 테스트 기능 차단
        // =====================================

        return res.status(403).json({

            error:
                "테스트 전용 기능은 비활성화되어 있습니다."
        });
    }
);


// =====================================
// 기존 요금제 변경 API
// =====================================

app.post("/api/plan/test-change", requireAuth, (req, res) => {
    const { plan } = req.body;

    if (!PLAN_RULES[plan]) {
        return res.status(400).json({
            error: "잘못된 요금제입니다."
        });
    }

    req.currentUser.plan = plan;
    writeDb(req.db);

    return res.json({
        message: `${plan} 요금제로 변경했습니다.`,
        dashboard: buildDashboard(req.currentUser)
    });
});



app.post("/api/test/reset-usage", requireAuth, (req, res) => {
    req.currentUser.usageAi = { date: todayString(), count: 0 };
    req.currentUser.usageAdvanced = { date: todayString(), count: 0, usedKeys: [] };
    writeDb(req.db);

    return res.json({
        message: "사용량을 리셋했습니다.",
        dashboard: buildDashboard(req.currentUser)
    });
});

// 성공·실패와 무관한 API 요청 폭주 방지. DB의 정상 사용 횟수와 별도.
const scorePathAnalysisRateV01 = new Map();
function scorePathAllowAnalysisAttemptV01(userId, kind) {
    const key = `${userId}:${kind}`;
    const limit = kind === "advanced" ? 12 : 30;
    const timeNow = Date.now();
    const recent = (scorePathAnalysisRateV01.get(key) || [])
        .filter(time => time > timeNow - 3600000);
    if (recent.length >= limit) return false;
    recent.push(timeNow);
    scorePathAnalysisRateV01.set(key, recent);
    return true;
}

app.post("/api/analyze", requireAuth, async (req, res) => {

    if (!scorePathAllowAnalysisAttemptV01(req.currentUser.id, "analyze")) {
        return res.status(429).json({ error: "분석 요청이 너무 많습니다. 잠시 후 다시 시도해주세요." });
    }
    console.log("🔥 /api/analyze 요청 들어옴");
console.log("user:", req.session?.user?.email || req.user?.email || "유저정보 없음");
    try {

      const {
    subject,
    problem,
    userAnswer,
    correctAnswer,

    // 사진 문제일 때 프론트에서 같이 보낼 값
    problemImageBase64 = "",
    problemImageContentType = "",
    problemImageKey = "",
    photoCount = 0,

    sourceType = "normal"
} = req.body;

const cleanSourceType =
    ["normal", "similar", "advanced"].includes(sourceType)
        ? sourceType
        : "normal";

const user = req.currentUser;
ensureUserShape(user);

const cleanSubject = safeText(subject);
const cleanProblem = safeText(problem);
const cleanUserAnswer = safeText(userAnswer);
const cleanCorrectAnswer = safeText(correctAnswer);

const cleanProblemImageBase64 =
    safeText(problemImageBase64);

const cleanProblemImageContentType =
    safeText(problemImageContentType);

const cleanProblemImageKey =
    safeText(problemImageKey);

const pendingProblemImageKeys =
    Array.isArray(
        req.session
            .pendingProblemImageKeys
    )
        ? req.session
            .pendingProblemImageKeys
        : [];

const isPendingProblemImage =
    Boolean(
        cleanProblemImageKey &&
        pendingProblemImageKeys.includes(
            cleanProblemImageKey
        )
    );

// 사진이 실제로 들어왔는지 여부
const hasProblemImage =
    Boolean(
        cleanProblemImageBase64 &&
        cleanProblemImageKey
    );

// 서버 직접 호출에서도 사진 소유권·형식·용량을 강제한다.
if (cleanProblemImageBase64 || cleanProblemImageKey) {
    const permitted = isPendingProblemImage || [
        ...(user.notes || []),
        ...(user.solvedNotes || []),
        ...(user.trashNotes || [])
    ].some(note => safeText(note.problemImageKey) === cleanProblemImageKey);
    const match = cleanProblemImageBase64.match(
        /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/i
    );
    if (!permitted || !match ||
        (cleanProblemImageContentType &&
         match[1].toLowerCase() !== cleanProblemImageContentType.toLowerCase()) ||
        match[2].length > 2 * 1024 * 1024 * 4 / 3 + 8) {
        return res.status(400).json({
            error: "사진의 소유권, 형식 또는 크기가 올바르지 않습니다."
        });
    }
}

const problemIdentity =
    getProblemIdentity(
        cleanProblem,
        cleanProblemImageKey
    );

console.log("sourceType:", cleanSourceType);

console.log("PROBLEM INPUT:", {
    hasTextProblem: Boolean(cleanProblem),
    hasProblemImage,
    problemImageContentType:
        cleanProblemImageContentType || "",
    problemImageKey:
        cleanProblemImageKey || ""
});

/*
 * 문제 입력 규칙
 *
 * 텍스트 문제:
 *   cleanProblem 필요
 *
 * 사진 문제:
 *   cleanProblemImageBase64 필요
 *
 * 둘 중 하나만 존재해도 분석 가능.
 */
if (
    !cleanSubject ||
    (!cleanProblem && !hasProblemImage) ||
    !cleanUserAnswer ||
    !cleanCorrectAnswer
) {
    return res.status(400).json({
        error:
            "과목, 문제 또는 문제 사진, 내 답, 정답을 모두 입력해주세요."
    });
}
        
function extractChoiceNumber(text) {
    const s = safeText(text);

    const circled = s.match(/[①②③④⑤⑥⑦⑧⑨⑩]/);
    if (circled) return circled[0];

    const normal = s.match(/^\s*([1-9]|10)(?:번|\s|[.)])/);
    if (normal) {
        const map = {
            "1": "①",
            "2": "②",
            "3": "③",
            "4": "④",
            "5": "⑤",
            "6": "⑥",
            "7": "⑦",
            "8": "⑧",
            "9": "⑨",
            "10": "⑩"
        };
        return map[normal[1]] || "";
    }

    return "";
}

if (cleanSourceType === "advanced") {
    const expectedAdvancedAnswer =
        safeText(user.advancedAnswerMap?.[cleanProblem]);

    if (
        expectedAdvancedAnswer &&
        !answersEquivalent(
            cleanCorrectAnswer,
            expectedAdvancedAnswer,
            cleanProblem
        )
    ) {
        return res.status(400).json({
            error: `입력한 정답이 응용문제의 실제 정답과 다릅니다. 이 문제의 정답은 ${expectedAdvancedAnswer} 입니다.`
        });
    }
}

     const mathCheck = validateSimpleMathConsistency(
    cleanProblem,
    cleanCorrectAnswer
);

if (mathCheck.detectable && !mathCheck.isValid) {
    return res.status(400).json({
        error: `입력한 정답이 문제와 맞지 않을 수 있습니다. 이 문제의 계산상 정답은 ${mathCheck.expected} 입니다.`
    });
}

// if (cleanUserAnswer === cleanCorrectAnswer) {
//     return res.status(400).json({
//         error: "정답인 상태에서는 AI 분석을 하지 않습니다."
//     });
// }

// =====================================
// 로컬에서 확실하게 정답이면 AI 호출 생략
// =====================================
const locallyCorrect = answersEquivalent(
    cleanUserAnswer,
    cleanCorrectAnswer,
    cleanProblem
);

if (locallyCorrect) {
    console.log("LOCAL ANSWER MATCH - SKIP AI:", {
        userAnswer: cleanUserAnswer,
        correctAnswer: cleanCorrectAnswer
    });
}

        const rule = getPlanRule(user.plan);

        // if (user.usageAi.count >= rule.aiDaily) {
        //     return res.status(403).json({ error: "오늘 AI 분석 횟수를 모두 사용했습니다." });
        // }
    

        const key = analysisKey(
    cleanSubject,
    problemIdentity,
    cleanUserAnswer,
    cleanCorrectAnswer,
    user.plan
);

        const isInTrash = user.trashNotes.some(
    (note) =>
        note.subject === cleanSubject &&
        getProblemIdentity(
            note.problem,
            note.problemImageKey
        ) === problemIdentity &&
        answersEquivalent(
            note.correctAnswer,
            cleanCorrectAnswer,
            cleanProblem
        )
);

if (
    user.analysisCache[key] &&
    !isInTrash &&
    !locallyCorrect
) {
    return res.json({
        message: "이미 분석한 입력입니다. 저장된 결과를 다시 보여줍니다. 차감되지 않았습니다.",
        analysis: user.analysisCache[key],
        cached: true,
        dashboard: buildDashboard(user)
    });
}

// 신규 정답·오답 저장 제한을 AI 호출 전에 확인해 비용 차감을 막는다.
const analyzeProblemIdentityV01 = noteKey(
    cleanSubject,
    problemIdentity,
    cleanCorrectAnswer
);
if (!canStoreProblemV01(user, analyzeProblemIdentityV01)) {
    return res.status(403).json({
        error: storedProblemLimitMessageV01(user),
        reason: "problem_storage_limit",
        usageConsumed: false
    });
}

// =====================================
// ScorePath 21-153
// AI 비용 발생 전에 일일 이용량 확인
// 캐시 재사용/로컬 정답 검사는 제외
// =====================================

if (
    !locallyCorrect &&
    process.env.OPENAI_API_KEY &&
    Number(user.usageAi?.count || 0) >= rule.aiDaily
) {

    return res.status(403).json({

        error:
            `오늘 AI 분석 횟수(${rule.aiDaily}회)를 모두 사용했습니다.`,

        reason:
            "ai_daily_limit"
    });
}

        // if (!rule.duplicateAnalyze) {
        //     const exists = user.notes.some(
        //         (note) =>
        //             note.subject === cleanSubject &&
        //             note.problem === cleanProblem &&
        //             note.correctAnswer === cleanCorrectAnswer
        //     );

        //     if (exists) {
        //         return res.status(403).json({ error: "무료 요금제에서는 같은 문제를 다시 분석할 수 없습니다." });
        //     }
        // }

       const apiKey = process.env.OPENAI_API_KEY;

let analysis;

// true = 정상 AI 분석이므로 캐시 가능
// false = fallback 분석이므로 캐시 금지
let shouldCacheAnalysis = false;

if (locallyCorrect) {
    // 이미 로컬 비교로 정답이 확실하므로 Gemini 호출 안 함
    analysis = {
        aiAnswer: cleanCorrectAnswer,
        verification: "match",
        warning: "",

        reason: "",
        weakConcept: "",
        errorType: "",
        problemType: "",

        concept: "",
        solution: "",
        similarProblems: [],

        advancedProblem: "아직 응용문제가 없습니다."
    };

} else if (!apiKey) {
    // 실제 AI 서비스를 사용하지 못할 때 가짜 분석으로 학습 기록을 만들지 않는다.
    return res.status(503).json({
        error: "현재 AI 분석 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.",
        reason: "ai_service_unavailable",
        usageConsumed: false
    });

} else {
    try {
        /*
 * 실제 AI 분석이 시작되는 시점에 1회 차감.
 * 사진 범위 오류/정답 검증 실패가 발생해도
 * 이미 AI 비용이 발생했으므로 사용량은 유지한다.
 */
user.usageAi.count += 1;
writeDb(req.db);

const result = await requestOpenAIAnalyze(
    cleanProblem,
    cleanUserAnswer,
    cleanCorrectAnswer,
    user.plan,
    apiKey,
    cleanProblemImageBase64,
    cleanProblemImageContentType,
    Number(photoCount) || 0
);

        const hiddenPairs = Array.isArray(result.similarAnswerPairs)
    ? result.similarAnswerPairs
    : [];

const {
    similarAnswerPairs,
    ...publicResult
} = result;

const publicSimilarProblems = hiddenPairs.map((pair) => {
    const id = randomUUID();

    user.similarAnswerMap[id] = {
    problem: pair.problem,

    generatedAnswer: pair.correctAnswer,

    verifiedAnswer: "",

    verificationStatus: "pending",

    // 이 유사문제의 정답 성공 처리가 이미 끝났는지 기록
    correctProcessed: false,
    correctProcessedAt: null,
    solvedNoteId: "",

    weaknessSource: {
        subject: cleanSubject,
        unit: publicResult.unit || "",
        weakConcept: publicResult.weakConcept || "",
        weakConceptDetail: publicResult.weakConceptDetail || "",
        errorType: publicResult.errorType || "",
        errorDetail: publicResult.errorDetail || "",
        problemType: publicResult.problemType || "",
        difficulty: publicResult.difficulty || ""
    },

    createdAt: now()
};

    return {
        id,
        problem: pair.problem
    };
});

analysis = {
    ...publicResult,
    similarProblems: publicSimilarProblems,
    advancedProblem: "아직 응용문제가 없습니다."
};

// 여기까지 왔다는 것은 AI 분석이 정상적으로 완료된 것
shouldCacheAnalysis = true;

    } catch (error) {
        // 실패한 분석은 저장하지 않고, 앱에서 소비된 분석 횟수만 복구한다.
        // 실제 외부 AI API 청구 비용은 반환되지 않을 수 있다.
        console.error("AI 분석 실패:", error?.code || error?.message);
        user.usageAi.count = Math.max(0, Number(user.usageAi.count || 0) - 1);
        writeDb(req.db);

        if (error?.code === "INVALID_PROBLEM_IMAGE_SCOPE") {
            try {
                await cleanupPendingProblemImage(req, cleanProblemImageKey);
            } catch (cleanupError) {
                console.error("R2 ORPHAN CLEANUP ERROR:", cleanupError?.message);
            }
            return res.status(422).json({
                error: "사진에 문제 하나의 지문·조건·선택지가 모두 보이도록 범위를 다시 지정해주세요.",
                verification: "uncertain",
                reason: "invalid_problem_image_scope",
                usageConsumed: false
            });
        }

        if (error?.code === "ANSWER_REVIEW_UNCERTAIN" ||
            String(error?.message || "").includes("정답 검증 결과가 서로 달라")) {
            const systemFailure = ["length", "max_tokens", "api_error", "json_parse", "empty"]
                .includes(error?.reviewFailure) ||
                ["length", "max_tokens"].includes(error?.finishReason);
            return res.status(409).json({
                error: systemFailure
                    ? "AI 검증 중 일시적인 오류가 발생했습니다. 다시 시도해주세요."
                    : "AI가 정답을 확실히 검증하지 못했습니다. 문제와 정답을 다시 확인해주세요.",
                verification: "uncertain",
                reason: systemFailure ? "answer_review_system_failure" : "insufficient_information",
                usageConsumed: false
            });
        }

        // 기존 fallback 분석은 기록과 전광판에 잘못된 근거를 쌓을 수 있어 중단한다.
        return res.status(503).json({
            error: "AI 분석을 완료하지 못했습니다. 잠시 후 다시 시도해주세요.",
            reason: "analysis_failure",
            usageConsumed: false
        });
    }
}

// 정상적으로 완료된 AI 분석만 캐시에 저장한다.
// JSON 파싱 실패 등의 fallback 분석은 저장하지 않는다.
if (shouldCacheAnalysis) {
    user.analysisCache[key] = analysis;
}

const identity = noteKey(
    cleanSubject,
    problemIdentity,
    cleanCorrectAnswer
);

const isCorrect = answersEquivalent(
    cleanUserAnswer,
    analysis.aiAnswer || cleanCorrectAnswer,
    cleanProblem
);

// ==============================
// 맞은 문제 → 복습완료
// ==============================
if (isCorrect) {
    const wrongIndex = user.notes.findIndex(
    (note) =>
        noteKey(
            note.subject,
            getProblemIdentity(
                note.problem,
                note.problemImageKey
            ),
            note.correctAnswer
        ) === identity
);

    let solvedNote = {
    id: randomUUID(),
    subject: cleanSubject,
unit: "",

problem: cleanProblem,
problemImageKey: cleanProblemImageKey,

userAnswer: cleanUserAnswer,
        correctAnswer: cleanCorrectAnswer,
        reason: analysis.reason || "",
weakConcept: analysis.weakConcept || "",
errorType: analysis.errorType || "",
problemType: analysis.problemType || "",
concept: analysis.concept || "",
solution: analysis.solution || "",
        similarProblems: analysis.similarProblems || [],
        advancedProblem: analysis.advancedProblem || "",
        sourceType: cleanSourceType,

difficulty: "",
reviewCount: 0,
repeatWrongCount: 0,
latestReviewResult: "correct",
masteryStatus: "learning",

createdAt: now(),
updatedAt: now(),
solvedAt: now()
    };

    // 기존 오답을 다시 풀어서 맞힌 경우
    if (wrongIndex !== -1) {
        solvedNote = {
    ...user.notes[wrongIndex],

    userAnswer: cleanUserAnswer,
    sourceType: cleanSourceType,

    reviewCount:
    (cleanSourceType === "similar" || cleanSourceType === "advanced")
        ? (user.notes[wrongIndex].reviewCount || 0) + 1
        : (user.notes[wrongIndex].reviewCount || 0),

    latestReviewResult: "correct",
    masteryStatus: "learning",

    updatedAt: now(),
    solvedAt: now()
};

        user.notes.splice(wrongIndex, 1);
    }

    const solvedIndex = user.solvedNotes.findIndex(
    (note) =>
        noteKey(
            note.subject,
            getProblemIdentity(
                note.problem,
                note.problemImageKey
            ),
            note.correctAnswer
        ) === identity
);

if (solvedIndex !== -1) {
    const existingSolved = user.solvedNotes[solvedIndex];

    user.solvedNotes[solvedIndex] = {
        ...existingSolved,
        ...solvedNote,

        reviewCount:
            wrongIndex !== -1
                ? solvedNote.reviewCount
                : (existingSolved.reviewCount || 0),

        repeatWrongCount:
            wrongIndex !== -1
                ? solvedNote.repeatWrongCount
                : (existingSolved.repeatWrongCount || 0)
    };
} else {
    user.solvedNotes.push(solvedNote);
}

} else {

    // ==============================
    // 틀린 문제 → 오답 리스트
    // ==============================
    const existingIndex = user.notes.findIndex(
    (note) =>
        noteKey(
            note.subject,
            getProblemIdentity(
                note.problem,
                note.problemImageKey
            ),
            note.correctAnswer
        ) === identity
);

// 이미 복습완료한 문제를 다시 틀린 경우
const solvedWrongIndex = user.solvedNotes.findIndex(
    (note) =>
        noteKey(
            note.subject,
            getProblemIdentity(
                note.problem,
                note.problemImageKey
            ),
            note.correctAnswer
        ) === identity
);

if (existingIndex === -1 && solvedWrongIndex !== -1) {
    const previousSolved = user.solvedNotes[solvedWrongIndex];

    user.notes.push({
        ...previousSolved,

        userAnswer: cleanUserAnswer,

        reason: analysis.reason || previousSolved.reason || "",
        unit:
    analysis.unit ||
    previousSolved.unit ||
    "",

weakConcept:
    analysis.weakConcept ||
    previousSolved.weakConcept ||
    "",

weakConceptDetail:
    analysis.weakConceptDetail ||
    previousSolved.weakConceptDetail ||
    "",

errorType:
    analysis.errorType ||
    previousSolved.errorType ||
    "",

errorDetail:
    analysis.errorDetail ||
    previousSolved.errorDetail ||
    "",

problemType:
    analysis.problemType ||
    previousSolved.problemType ||
    "",

difficulty:
    analysis.difficulty ||
    previousSolved.difficulty ||
    "",
        concept:
            analysis.concept ||
            previousSolved.concept ||
            "",
        solution:
            analysis.solution ||
            previousSolved.solution ||
            "",

        similarProblems:
            analysis.similarProblems ||
            previousSolved.similarProblems ||
            [],

        advancedProblem:
            analysis.advancedProblem ||
            previousSolved.advancedProblem ||
            "",

        sourceType: cleanSourceType,

        // 기존 복습 횟수 유지
        reviewCount: previousSolved.reviewCount || 0,

        // 다시 틀렸으므로 +1
        repeatWrongCount:
            (previousSolved.repeatWrongCount || 0) + 1,

        latestReviewResult: "wrong",
        masteryStatus: "learning",

        // 최초 생성 시점 유지
        createdAt: previousSolved.createdAt,

        // 이번 오답 시점만 갱신
        updatedAt: now()
    });

    // solvedNotes에서는 제거
    user.solvedNotes.splice(solvedWrongIndex, 1);


    } else if (existingIndex === -1) {
        if (
            rule.storageLimit !== Infinity &&
            getStoredProblemCountV01(user) >= rule.storageLimit
        ) {
            return res.status(403).json({
                error: storedProblemLimitMessageV01(user)
            });
        }

        user.notes.push({
    id: randomUUID(),

    subject: cleanSubject,
unit: analysis.unit || "",

problem: cleanProblem,
problemImageKey: cleanProblemImageKey,

userAnswer: cleanUserAnswer,
correctAnswer: cleanCorrectAnswer,
    reason: analysis.reason || "",

    weakConcept: analysis.weakConcept || "",
    weakConceptDetail: analysis.weakConceptDetail || "",

    errorType: analysis.errorType || "",
    errorDetail: analysis.errorDetail || "",

    problemType: analysis.problemType || "",
    difficulty: analysis.difficulty || "",

    concept: analysis.concept || "",
    solution: analysis.solution || "",

    similarProblems: analysis.similarProblems || [],
    advancedProblem: analysis.advancedProblem || "",

    sourceType: cleanSourceType,

    reviewCount: 0,
    repeatWrongCount: 1,
    latestReviewResult: "wrong",
    masteryStatus: "learning",

    createdAt: now(),
    updatedAt: now()
});

    } else {
        const existingNote = user.notes[existingIndex];

        user.notes[existingIndex] = {
            ...existingNote,

            userAnswer: cleanUserAnswer,

            // 정답확인에서 이미 오답 횟수를 기록했으므로
            // AI 분석에서는 분석 내용만 보충한다.
            reason:
                analysis.reason ||
                existingNote.reason ||
                "",

            concept:
                analysis.concept ||
                existingNote.concept ||
                "",

            solution:
                analysis.solution ||
                existingNote.solution ||
                "",

            similarProblems:
                Array.isArray(analysis.similarProblems)
                    ? analysis.similarProblems
                    : (existingNote.similarProblems || []),

            advancedProblem:
                analysis.advancedProblem ||
                existingNote.advancedProblem ||
                "",

            // 기존 약점 분류가 있으면 그대로 유지한다.
            // AI 재분석 표현 차이로 weaknessKey가 갈라지는 것을 방지한다.
            unit:
                existingNote.unit ||
                analysis.unit ||
                "",

            weakConcept:
                existingNote.weakConcept ||
                analysis.weakConcept ||
                "",

            weakConceptDetail:
                existingNote.weakConceptDetail ||
                analysis.weakConceptDetail ||
                "",

            errorType:
                existingNote.errorType ||
                analysis.errorType ||
                "",

            errorDetail:
                existingNote.errorDetail ||
                analysis.errorDetail ||
                "",

            problemType:
                existingNote.problemType ||
                analysis.problemType ||
                "",

            difficulty:
                existingNote.difficulty ||
                analysis.difficulty ||
                "",

            sourceType: cleanSourceType,

            // 중요:
            // /api/notes/check에서 이미 이번 오답을 +1 했으므로
            // AI 분석에서는 다시 증가시키지 않는다.
            repeatWrongCount:
                existingNote.repeatWrongCount || 1,

            latestReviewResult: "wrong",
            masteryStatus: "learning",

            updatedAt: now()
        };
    }
}

                               // 방금 저장되거나 갱신된 오답을 찾는다.
        const weaknessEventNote =
    user.solvedNotes.find(
        (note) =>
            noteKey(
                note.subject,
                getProblemIdentity(
                    note.problem,
                    note.problemImageKey
                ),
                note.correctAnswer
            ) === identity
    );

        // 같은 문제의 이번 오답 이벤트가 이미 정답확인 단계에서
        // 기록되었는지 확인한다.
        const alreadyRecordedWrongEvent =
            user.learningEvents.some(
                (event) =>
                    safeText(event.noteId) ===
                        safeText(weaknessEventNote?.id) &&
                    event.result === "wrong" &&
                    Number(event.createdAt || 0) >=
                        Number(weaknessEventNote?.updatedAt || 0) - 5000
            );

        // 정답확인을 거치지 않고 AI 분석을 바로 실행한 경우에만
        // 오답 이벤트를 새로 기록한다.
        if (
            weaknessEventNote &&
            !alreadyRecordedWrongEvent
        ) {
            recordLearningEvent(
                user,
                weaknessEventNote,
                "wrong",
                Number(
                    weaknessEventNote.repeatWrongCount || 0
                ) <= 1
                    ? "initial"
                    : "retry",
                cleanSourceType
            );
        }

        // AI 분석으로 약점 정보가 추가되었을 수 있으므로
        // 약점 프로필과 복습 스케줄을 다시 계산한다.
        refreshWeaknessSystem(user);

writeDb(req.db);

/*
 * 분석이 정상 완료됐으므로
 * 이 사진은 이제 실제 문제 데이터에 연결됐다.
 * pending 상태만 해제한다.
 */
if (
    isPendingProblemImage &&
    cleanProblemImageKey
) {
    req.session.pendingProblemImageKeys =
        (
            req.session
                .pendingProblemImageKeys ||
            []
        ).filter(
            (key) =>
                key !==
                cleanProblemImageKey
        );
}

return res.json({
    message:
        "AI 분석을 저장했습니다.",

    analysis,

    cached: false,

    dashboard:
        buildDashboard(user)
});

} catch (error) {
    console.error(error);

    /*
     * 이번 세션에서 새로 업로드한 사진인데
     * 분석이 예상치 못한 오류로 실패했다면
     * DB와 연결되지 않은 R2 사진을 삭제한다.
     *
     * 기존 저장 사진은 pending이 아니므로 삭제되지 않는다.
     */
    

    return res
        .status(500)
        .json({
            error:
                "분석 중 서버 오류가 발생했습니다."
        });
}
});

app.post("/api/advanced-problem", requireAuth, async (req, res) => {
    if (!scorePathAllowAnalysisAttemptV01(req.currentUser.id, "advanced")) {
        return res.status(429).json({ error: "응용문제 요청이 너무 많습니다. 잠시 후 다시 시도해주세요." });
    }
    try {
        const {
            subject,
            problem,
            problemImageKey = "",
            problemImageBase64 = "",
            problemImageContentType = "",
            photoCount = 0
        } = req.body;

        const user = req.currentUser;
        ensureUserShape(user);

        const cleanSubject = safeText(subject);
        const cleanProblem = safeText(problem);
        const cleanImageKey = safeText(problemImageKey);

        const imageData =
            typeof problemImageBase64 === "string"
                ? problemImageBase64
                : "";

        const hasImage = Boolean(imageData);

        // 텍스트 또는 사진 중 하나만 있어도 허용
        if (!cleanProblem && !hasImage) {
            return res.status(400).json({
                error: "문제 또는 문제 사진을 입력해주세요."
            });
        }

        const rule = getPlanRule(user.plan);

        if (!rule.advancedEnabled) {
            return res.status(403).json({
                error:
                    "응용문제는 8900원 요금제에서만 사용할 수 있습니다."
            });
        }

        // =====================================
        // 응용문제 사진 입력 검증
        // =====================================

        let safeImageDataUrl = "";

        if (hasImage) {

            const match = imageData.match(
                /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/i
            );

            const supportedTypes = [
                "image/webp",
                "image/jpeg",
                "image/png"
            ];

            const contentType =
                safeText(problemImageContentType)
                    .toLowerCase();

            if (
                !match ||
                !supportedTypes.includes(
                    match[1].toLowerCase()
                ) ||
                (
                    contentType &&
                    contentType !== match[1].toLowerCase()
                ) ||
                Buffer.from(
                    match[2],
                    "base64"
                ).length > 2 * 1024 * 1024
            ) {
                return res.status(400).json({
                    error:
                        "문제 사진 형식이나 크기가 올바르지 않습니다."
                });
            }

            // 기존 R2 사진 소유권 확인
            const pendingKeys =
                Array.isArray(
                    req.session?.pendingProblemImageKeys
                )
                    ? req.session.pendingProblemImageKeys
                    : [];

            const ownsImage =
                cleanImageKey.startsWith("problem-images/") &&
                (
                    pendingKeys.includes(cleanImageKey) ||

                    [
                        ...(user.notes || []),
                        ...(user.solvedNotes || []),
                        ...(user.trashNotes || [])
                    ].some(
                        (note) =>
                            safeText(
                                note.problemImageKey
                            ) === cleanImageKey
                    )
                );

            if (!ownsImage) {
                return res.status(403).json({
                    error:
                        "본인에게 연결된 문제 사진만 사용할 수 있습니다."
                });
            }

            safeImageDataUrl = imageData;
        }

        // 사진 문제는 사진 키까지 중복 검사에 반영
        const identity =
            cleanImageKey && hasImage
                ? `${cleanProblem}::image:${cleanImageKey}`
                : cleanProblem;

        const key = advancedProblemKey(
            cleanSubject,
            identity
        );

         // =====================================
        // ScorePath 21-372
        // 개발 환경 응용문제 횟수 제한 해제
        // =====================================

        const advancedUnlimitedTestV01 =
            process.env.NODE_ENV !== "production" &&
            process.env.SCOREPATH_ADVANCED_UNLIMITED_TEST === "true";

        // =====================================
        // ScorePath 21-379
        // 요금제별 응용문제 생성 제한
        // =====================================

        const advancedDailyLimit =
            Number(rule.advancedDaily || 0);

        if (
            !advancedUnlimitedTestV01 &&
            Number(user.usageAdvanced?.count || 0) >=
                advancedDailyLimit
        ) {

            return res.status(403).json({

                error:
                    `오늘 응용문제 생성 ${advancedDailyLimit}회를 모두 사용했습니다.`,

                reason:
                    "advanced_daily_limit"
            });
        }

        if (
            !advancedUnlimitedTestV01 &&
            user.usageAdvanced.usedKeys.includes(key)
        ) {

            return res.status(403).json({
                error: "이 문제는 이미 응용문제를 생성했습니다."
            });
        }

        const apiKey = process.env.OPENAI_API_KEY;
       let advancedProblem = "";
let advancedAnswer = "";

if (!apiKey) {
    const fallback = makeFallbackAdvancedProblem(cleanProblem);

    advancedProblem =
        typeof fallback === "string"
            ? fallback
            : fallback.advancedProblem;

    advancedAnswer =
        typeof fallback === "object"
            ? safeText(fallback.answer)
            : "";
} else {
    try {
        const result = await requestOpenAIAdvanced(
    cleanProblem,
    apiKey,
    safeImageDataUrl,
    Number(photoCount) || 0
);

        advancedProblem = safeText(result.advancedProblem);
        advancedAnswer = safeText(result.answer);
    } catch (error) {
        console.error("Advanced fallback:", error.message);

        const fallback = makeFallbackAdvancedProblem(cleanProblem);

        advancedProblem =
            typeof fallback === "string"
                ? fallback
                : fallback.advancedProblem;

        advancedAnswer =
            typeof fallback === "object"
                ? safeText(fallback.answer)
                : "";
    }
}

// 문제 또는 정답 생성에 실패하면 사용 기록을 남기지 않는다.
if (!advancedProblem || !advancedAnswer) {
    console.error("ADVANCED GENERATION FAILED - usage not charged");

    return res.status(502).json({
        error: "응용문제를 생성하지 못했습니다. 다시 시도해주세요. 사용 횟수는 차감되지 않았습니다."
    });
}

// 여기부터는 정상 생성 성공
user.advancedAnswerMap[advancedProblem] = advancedAnswer;

// 성공한 경우에만 사용 횟수와 중복방지 기록 저장
user.usageAdvanced.count += 1;
user.usageAdvanced.usedKeys.push(key);

writeDb(req.db);

console.log("advancedAnswerMap =", user.advancedAnswerMap);

return res.json({
    message: "응용문제를 생성했습니다.",
    advancedProblem,
    dashboard: buildDashboard(user)
});
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "응용문제 생성 중 서버 오류가 발생했습니다." });
    }
});

// ================================
// 6단계 - 약점 훈련
// ================================

// --------------------------------
// 약점 훈련 시작
// --------------------------------

app.post("/api/training/start", requireAuth, (req, res) => {
    try {
        const {
            weaknessKey
        } = req.body;

        const user = req.currentUser;

        ensureUserShape(user);
        refreshWeaknessSystem(user);

        const cleanWeaknessKey =
            safeText(weaknessKey);

        if (!cleanWeaknessKey) {
            return res.status(400).json({
                error:
                    "훈련할 약점 정보가 없습니다."
            });
        }

        // 현재 약점 프로필에서 해당 약점 찾기
        const weakness =
            Object.values(
                user.weaknessProfile || {}
            )
            .flatMap((subjectProfile) =>
                Object.entries(
                    subjectProfile || {}
                )
            )
            .find(
                ([key]) =>
                    key === cleanWeaknessKey
            )?.[1];

        if (!weakness) {
            return res.status(404).json({
                error:
                    "훈련할 약점을 찾을 수 없습니다."
            });
        }

        const schedule =
            user.reviewSchedule?.[
                cleanWeaknessKey
            ];

        if (
            schedule &&
            (
                safeText(
                    schedule.masteryStatus
                ) === "mastered" ||
                Number(
                    schedule.stage || 0
                ) >= 6
            )
        ) {
            return res.status(400).json({
                error:
                    "이미 극복한 약점입니다."
            });
        }

        if (
            !user.weaknessTrainingAttempts ||
            typeof user.weaknessTrainingAttempts !==
                "object" ||
            Array.isArray(
                user.weaknessTrainingAttempts
            )
        ) {
            user.weaknessTrainingAttempts = {};
        }

        // 같은 약점에서 이미 진행 중인 훈련이 있으면 재사용
        const existingAttempt =
            Object.values(
                user.weaknessTrainingAttempts
            )
            .filter(
                (attempt) =>
                    attempt &&
                    attempt.status === "active" &&
                    safeText(
                        attempt.weaknessKey
                    ) === cleanWeaknessKey
            )
            .sort(
                (a, b) =>
                    Number(
                        b.createdAt || 0
                    ) -
                    Number(
                        a.createdAt || 0
                    )
            )[0];

        if (existingAttempt) {
            return res.json({
                trainingAttemptId:
                    existingAttempt.id,

                weaknessKey:
                    cleanWeaknessKey,

                subject:
                    existingAttempt.subject,

                problem:
                    existingAttempt.problem,

                label:
                    safeText(
                        weakness.label
                    ) ||
                    "훈련할 약점",

                weaknessScore:
                    Number(
                        weakness.weaknessScore ||
                        0
                    ),

                reused: true
            });
        }

        // 이 약점과 연결된 실제 학습 문제를 찾는다.
        const candidates = [
            ...(Array.isArray(user.notes)
                ? user.notes
                : []),

            ...(Array.isArray(
                user.solvedNotes
            )
                ? user.solvedNotes
                : [])
        ]
        .filter((note) => {
            if (!note) {
                return false;
            }

            if (
                !safeText(note.problem) ||
                !safeText(note.correctAnswer)
            ) {
                return false;
            }

            const info =
                getWeaknessKey(note);

            return (
                info.key ===
                cleanWeaknessKey
            );
        })
        .sort((a, b) => {
            // 아직 해결되지 않은 오답을 우선
            const aWrong =
                user.notes.some(
                    (note) =>
                        note.id === a.id
                )
                    ? 1
                    : 0;

            const bWrong =
                user.notes.some(
                    (note) =>
                        note.id === b.id
                )
                    ? 1
                    : 0;

            if (bWrong !== aWrong) {
                return bWrong - aWrong;
            }

            // 반복 오답 횟수가 많은 문제 우선
            const repeatDifference =
                Number(
                    b.repeatWrongCount || 0
                ) -
                Number(
                    a.repeatWrongCount || 0
                );

            if (repeatDifference !== 0) {
                return repeatDifference;
            }

            // 같으면 최근 문제 우선
            return (
                Number(
                    b.updatedAt ||
                    b.createdAt ||
                    0
                ) -
                Number(
                    a.updatedAt ||
                    a.createdAt ||
                    0
                )
            );
        });

        const selectedNote =
            candidates[0];

        if (!selectedNote) {
            return res.status(404).json({
                error:
                    "이 약점과 연결된 훈련 문제를 찾을 수 없습니다."
            });
        }

        const trainingAttemptId =
            randomUUID();

        const currentTime =
            now();

        user.weaknessTrainingAttempts[
            trainingAttemptId
        ] = {
            id:
                trainingAttemptId,

            weaknessKey:
                cleanWeaknessKey,

            noteId:
                selectedNote.id,

            subject:
                selectedNote.subject,

            problem:
                selectedNote.problem,

            // 정답은 브라우저에 보내지 않는다.
            correctAnswer:
                selectedNote.correctAnswer,

            status:
                "active",

            createdAt:
                currentTime
        };

        writeDb(req.db);

        return res.json({
            trainingAttemptId,

            weaknessKey:
                cleanWeaknessKey,

            subject:
                selectedNote.subject,

            problem:
                selectedNote.problem,

            label:
                safeText(
                    weakness.label
                ) ||
                "훈련할 약점",

            weaknessScore:
                Number(
                    weakness.weaknessScore ||
                    0
                ),

            reused: false
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error:
                "약점 훈련을 시작하는 중 서버 오류가 발생했습니다."
        });
    }
});


// --------------------------------
// 약점 훈련 정답 확인
// --------------------------------

app.post("/api/training/check", requireAuth, (req, res) => {
    try {
        const {
            trainingAttemptId,
            userAnswer
        } = req.body;

        const user = req.currentUser;

        ensureUserShape(user);

        const cleanTrainingAttemptId =
            safeText(trainingAttemptId);

        const cleanUserAnswer =
            safeText(userAnswer);

        if (
            !cleanTrainingAttemptId ||
            !cleanUserAnswer
        ) {
            return res.status(400).json({
                error:
                    "훈련 식별 정보와 답을 모두 입력해주세요."
            });
        }

        if (
            !user.weaknessTrainingAttempts ||
            typeof user.weaknessTrainingAttempts !==
                "object" ||
            Array.isArray(
                user.weaknessTrainingAttempts
            )
        ) {
            return res.status(400).json({
                error:
                    "진행 중인 약점 훈련이 없습니다."
            });
        }

        const attempt =
            user.weaknessTrainingAttempts[
                cleanTrainingAttemptId
            ];

        if (!attempt) {
            return res.status(404).json({
                error:
                    "약점 훈련 정보를 찾을 수 없습니다."
            });
        }

        // 중복 제출 방지
        if (attempt.status !== "active") {
            return res.json({
                duplicate: true,

                isCorrect:
                    attempt.result ===
                    "correct",

                message:
                    "이미 처리된 약점 훈련입니다.",

                dashboard:
                    buildDashboard(user)
            });
        }

        const cleanProblem =
            safeText(attempt.problem);

        const cleanCorrectAnswer =
            safeText(
                attempt.correctAnswer
            );

        if (
            !cleanProblem ||
            !cleanCorrectAnswer
        ) {
            return res.status(400).json({
                error:
                    "약점 훈련 문제의 정답 정보를 찾을 수 없습니다."
            });
        }

        const allNotes = [
            ...(Array.isArray(user.notes)
                ? user.notes
                : []),

            ...(Array.isArray(
                user.solvedNotes
            )
                ? user.solvedNotes
                : [])
        ];

        const trainingNote =
            allNotes.find(
                (note) =>
                    safeText(note.id) ===
                    safeText(attempt.noteId)
            );

        if (!trainingNote) {
            return res.status(404).json({
                error:
                    "약점 훈련과 연결된 학습 기록을 찾을 수 없습니다."
            });
        }

        const actualWeakness =
            getWeaknessKey(trainingNote);

        if (
            actualWeakness.key !==
            attempt.weaknessKey
        ) {
            return res.status(400).json({
                error:
                    "약점 훈련 정보가 현재 학습 기록과 일치하지 않습니다."
            });
        }

        // 여기까지 검증이 끝난 뒤 잠금
        attempt.status =
            "processing";

        attempt.processingAt =
            now();

        const isCorrect =
            answersEquivalent(
                cleanUserAnswer,
                cleanCorrectAnswer,
                cleanProblem
            );

        // 예약복습과 다르게
        // reviewSchedule의 stage/nextReviewAt은 변경하지 않는다.
        recordLearningEvent(
            user,
            trainingNote,
            isCorrect
                ? "correct"
                : "wrong",
            "weakness_training",
            "weakness_training"
        );

        attempt.status =
            "completed";

        delete attempt.processingAt;

        attempt.result =
            isCorrect
                ? "correct"
                : "wrong";

        attempt.userAnswer =
            cleanUserAnswer;

        attempt.completedAt =
            now();

        // 새 훈련 결과를 약점 점수에 반영
        refreshWeaknessSystem(user);

        writeDb(req.db);

        return res.json({
            duplicate: false,

            isCorrect,

            message:
                isCorrect
                    ? "정답입니다! 약점 훈련 결과가 반영되었습니다."
                    : "틀렸습니다. 이 약점은 추가 훈련이 필요합니다.",

            weaknessKey:
                attempt.weaknessKey,

            dashboard:
                buildDashboard(user)
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error:
                "약점 훈련 채점 중 서버 오류가 발생했습니다."
        });
    }
});

app.post("/api/reviews/start", requireAuth, (req, res) => {
    try {
        const {
            weaknessKey
        } = req.body;

        const user = req.currentUser;

        ensureUserShape(user);
        refreshWeaknessSystem(user);

        const cleanWeaknessKey =
            safeText(weaknessKey);

        if (!cleanWeaknessKey) {
            return res.status(400).json({
                error:
                    "복습할 약점 정보가 없습니다."
            });
        }

        const schedule =
            user.reviewSchedule?.[
                cleanWeaknessKey
            ];

        if (!schedule) {
            return res.status(404).json({
                error:
                    "복습 스케줄을 찾을 수 없습니다."
            });
        }

        if (
            safeText(schedule.masteryStatus) ===
                "mastered" ||
            Number(schedule.stage || 1) >= 6
        ) {
            return res.status(400).json({
                error:
                    "이미 극복한 약점입니다."
            });
        }

        const currentTime = now();

        if (
            !schedule.nextReviewAt ||
            Number(schedule.nextReviewAt) >
                currentTime
        ) {
            return res.status(400).json({
                error:
                    "아직 복습할 시간이 되지 않았습니다."
            });
        }

        if (
            !user.scheduledReviewAttempts ||
            typeof user.scheduledReviewAttempts !==
                "object" ||
            Array.isArray(
                user.scheduledReviewAttempts
            )
        ) {
            user.scheduledReviewAttempts = {};
        }

        // =====================================
        // 같은 약점의 active attempt 정리
        // =====================================
        //
        // 정상적인 현재 복습 attempt만 재사용한다.
        //
        // 아래 두 경우는 오래된 attempt로 판단:
        //
        // 1. 마지막 복습 완료 시점보다 전에 만들어진 attempt
        // 2. 생성 후 24시간 이상 지난 attempt
        //
        // 오래된 attempt는 cancelled 처리하고
        // 새로운 attempt를 만든다.
        // =====================================

        const ACTIVE_ATTEMPT_MAX_AGE_MS =
            24 * 60 * 60 * 1000;

        const sameWeaknessActiveAttempts =
            Object.values(
                user.scheduledReviewAttempts
            )
            .filter(
                (attempt) =>
                    attempt &&
                    attempt.status === "active" &&
                    safeText(
                        attempt.weaknessKey
                    ) === cleanWeaknessKey
            )
            .sort(
                (a, b) =>
                    Number(b.createdAt || 0) -
                    Number(a.createdAt || 0)
            );

        let existingActiveAttempt = null;
        let attemptsChanged = false;

        for (
            const attempt of
            sameWeaknessActiveAttempts
        ) {
            const createdAt =
                Number(attempt.createdAt || 0);

            const lastReviewAt =
                Number(schedule.lastReviewAt || 0);

            const createdBeforeLastReview =
                lastReviewAt > 0 &&
                createdAt <= lastReviewAt;

            const tooOld =
                !createdAt ||
                currentTime - createdAt >
                    ACTIVE_ATTEMPT_MAX_AGE_MS;

            // 이전 복습 회차의 attempt거나
            // 너무 오래 방치된 attempt면 만료
            if (
                createdBeforeLastReview ||
                tooOld
            ) {
                attempt.status = "cancelled";
                attempt.cancelledAt =
                    currentTime;

                attempt.cancelReason =
                    createdBeforeLastReview
                        ? "stale_review_cycle"
                        : "active_attempt_expired";

                attemptsChanged = true;

                continue;
            }

            // 가장 최근의 정상 active attempt 하나만 재사용
            if (!existingActiveAttempt) {
                existingActiveAttempt =
                    attempt;

                continue;
            }

            // 같은 약점에 active가 여러 개 남아 있으면
            // 가장 최신 것 하나만 유지
            attempt.status = "cancelled";
            attempt.cancelledAt =
                currentTime;
            attempt.cancelReason =
                "duplicate_active_attempt";

            attemptsChanged = true;
        }

        if (existingActiveAttempt) {
            if (attemptsChanged) {
                writeDb(req.db);
            }

            return res.json({
                reviewAttemptId:
                    existingActiveAttempt.id,

                weaknessKey:
                    existingActiveAttempt
                        .weaknessKey,

                subject:
                    existingActiveAttempt.subject,

                problem:
                    existingActiveAttempt.problem,

                stage:
                    Number(schedule.stage || 1),

                label:
                    safeText(schedule.label) ||
                    "복습할 약점",

                reused: true
            });
        }

        // =====================================
        // 정상 active가 없을 때 새 문제 생성
        // =====================================

        const candidates = [
            ...(Array.isArray(user.notes)
                ? user.notes
                : []),

            ...(Array.isArray(user.solvedNotes)
                ? user.solvedNotes
                : [])
        ]
        .filter((note) => {
            if (!note) {
                return false;
            }

            const problem =
                safeText(note.problem);

            const correctAnswer =
                safeText(note.correctAnswer);

            if (
                !problem ||
                !correctAnswer
            ) {
                return false;
            }

            const info =
                getWeaknessKey(note);

            return (
                info.key ===
                cleanWeaknessKey
            );
        })
        .sort(
            (a, b) =>
                Number(
                    b.updatedAt ||
                    b.createdAt ||
                    0
                ) -
                Number(
                    a.updatedAt ||
                    a.createdAt ||
                    0
                )
        );

        const selectedNote =
            candidates[0];

        if (!selectedNote) {
            if (attemptsChanged) {
                writeDb(req.db);
            }

            return res.status(404).json({
                error:
                    "이 약점과 연결된 복습 문제를 찾을 수 없습니다."
            });
        }

        const reviewAttemptId =
            randomUUID();

        user.scheduledReviewAttempts[
            reviewAttemptId
        ] = {
            id:
                reviewAttemptId,

            weaknessKey:
                cleanWeaknessKey,

            noteId:
                selectedNote.id,

            subject:
                selectedNote.subject,

            problem:
                selectedNote.problem,

            // 브라우저에는 보내지 않고
            // 서버 DB에만 저장
            correctAnswer:
                selectedNote.correctAnswer,

            status:
                "active",

            createdAt:
                currentTime
        };

        writeDb(req.db);

        return res.json({
            reviewAttemptId,

            weaknessKey:
                cleanWeaknessKey,

            subject:
                selectedNote.subject,

            problem:
                selectedNote.problem,

            stage:
                Number(schedule.stage || 1),

            label:
                safeText(schedule.label) ||
                "복습할 약점",

            reused: false
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error:
                "예약 복습을 시작하는 중 서버 오류가 발생했습니다."
        });
    }
});


app.post("/api/reviews/check", requireAuth, (req, res) => {
    try {
        const {
            reviewAttemptId,
            userAnswer
        } = req.body;

        const user = req.currentUser;

        ensureUserShape(user);

        const cleanReviewAttemptId =
            safeText(reviewAttemptId);

        const cleanUserAnswer =
            safeText(userAnswer);

        if (
            !cleanReviewAttemptId ||
            !cleanUserAnswer
        ) {
            return res.status(400).json({
                error:
                    "복습 식별 정보와 답을 모두 입력해주세요."
            });
        }

        if (
            !user.scheduledReviewAttempts ||
            typeof user.scheduledReviewAttempts !==
                "object" ||
            Array.isArray(
                user.scheduledReviewAttempts
            )
        ) {
            return res.status(400).json({
                error:
                    "진행 중인 예약 복습 정보가 없습니다."
            });
        }

        const attempt =
            user.scheduledReviewAttempts[
                cleanReviewAttemptId
            ];

        if (!attempt) {
            return res.status(404).json({
                error:
                    "예약 복습 정보를 찾을 수 없습니다."
            });
        }

        // =====================================
        // 이미 처리됐거나 처리 중인 attempt 차단
        // =====================================

        if (attempt.status !== "active") {
            return res.json({
                duplicate: true,

                isCorrect:
                    attempt.result === "correct",

                message:
                    attempt.status === "processing"
                        ? "이미 처리 중인 예약 복습입니다."
                        : "이미 처리된 예약 복습입니다.",

                reviewResult:
                    attempt.reviewResult || null,

                dashboard:
                    buildDashboard(user)
            });
        }

        const schedule =
            user.reviewSchedule?.[
                attempt.weaknessKey
            ];

        if (!schedule) {
            return res.status(404).json({
                error:
                    "이 약점의 복습 스케줄을 찾을 수 없습니다."
            });
        }

        if (
            schedule.masteryStatus ===
            "mastered"
        ) {
            return res.status(400).json({
                error:
                    "이미 극복한 약점입니다."
            });
        }

        // 예약 시간이 실제로 되었는지
        // 이벤트 기록 전에 먼저 확인한다.
        const currentTime = now();

        if (
            !schedule.nextReviewAt ||
            Number(schedule.nextReviewAt) >
                currentTime
        ) {
            return res.status(400).json({
                error:
                    "아직 예약 복습 시간이 되지 않았습니다.",
                reason:
                    "not_due_yet"
            });
        }

        // start 때 서버에 저장한 문제/정답만 사용한다.
        const cleanProblem =
            safeText(attempt.problem);

        const cleanCorrectAnswer =
            safeText(attempt.correctAnswer);

        if (
            !cleanProblem ||
            !cleanCorrectAnswer
        ) {
            return res.status(400).json({
                error:
                    "예약 복습 문제의 정답 정보를 찾을 수 없습니다."
            });
        }

        const isCorrect =
            answersEquivalent(
                cleanUserAnswer,
                cleanCorrectAnswer,
                cleanProblem
            );

        const allNotes = [
            ...(Array.isArray(user.notes)
                ? user.notes
                : []),

            ...(Array.isArray(user.solvedNotes)
                ? user.solvedNotes
                : [])
        ];

        const reviewNote =
            allNotes.find(
                (note) =>
                    safeText(note.id) ===
                    safeText(attempt.noteId)
            );

        if (!reviewNote) {
            return res.status(404).json({
                error:
                    "예약 복습과 연결된 학습 기록을 찾을 수 없습니다."
            });
        }

        const actualWeakness =
            getWeaknessKey(reviewNote);

        if (
            actualWeakness.key !==
            attempt.weaknessKey
        ) {
            return res.status(400).json({
                error:
                    "예약 복습의 약점 정보가 현재 학습 기록과 일치하지 않습니다."
            });
        }

        // =====================================
        // 여기까지 모든 사전 검증 완료
        //
        // 이 순간부터 이 attempt를 잠근다.
        // 같은 요청이 다시 들어오면
        // active가 아니므로 위에서 차단된다.
        // =====================================

        attempt.status = "processing";
        attempt.processingAt = currentTime;

        const reviewResult =
            processScheduledReviewResult(
                user,
                attempt.weaknessKey,
                isCorrect
                    ? "correct"
                    : "wrong"
            );

        if (!reviewResult.processed) {
            // 처리 실패 시 다시 시도할 수 있도록
            // attempt를 active로 되돌린다.
            attempt.status = "active";

            delete attempt.processingAt;

            return res.status(400).json({
                error:
                    reviewResult.reason ===
                    "not_due_yet"
                        ? "아직 예약 복습 시간이 되지 않았습니다."
                        : "예약 복습 결과를 처리할 수 없습니다.",

                reason:
                    reviewResult.reason
            });
        }

        // =====================================
        // 스케줄 처리가 성공한 뒤에만
        // 학습 이벤트를 기록한다.
        // =====================================

        recordLearningEvent(
            user,
            reviewNote,
            isCorrect
                ? "correct"
                : "wrong",
            "spaced_review",
            "scheduled_review"
        );

        // =====================================
        // 같은 약점의 다른 active attempt 정리
        // =====================================

        Object.values(
            user.scheduledReviewAttempts || {}
        ).forEach((savedAttempt) => {
            if (
                savedAttempt &&
                savedAttempt.id !== attempt.id &&
                savedAttempt.status === "active" &&
                safeText(
                    savedAttempt.weaknessKey
                ) ===
                    safeText(
                        attempt.weaknessKey
                    )
            ) {
                savedAttempt.status =
                    "cancelled";

                savedAttempt.cancelledAt =
                    now();

                savedAttempt.cancelReason =
                    "same_weakness_review_completed";
            }
        });

        // =====================================
        // 실제 제출 attempt 완료 처리
        // =====================================

        attempt.status = "completed";

        delete attempt.processingAt;

        attempt.result =
            isCorrect
                ? "correct"
                : "wrong";

        attempt.userAnswer =
            cleanUserAnswer;

        attempt.completedAt =
            now();

        attempt.reviewResult = {
            stage:
                reviewResult.schedule.stage,

            intervalDays:
                reviewResult.schedule
                    .intervalDays,

            nextReviewAt:
                reviewResult.schedule
                    .nextReviewAt,

            masteryStatus:
                reviewResult.schedule
                    .masteryStatus,

            mastered:
                reviewResult.mastered === true
        };

        // 새 spaced_review 이벤트까지 반영
        user.weaknessProfile =
            buildWeaknessProfile(user);

        writeDb(req.db);

        return res.json({
            duplicate: false,

            isCorrect,

            message:
                isCorrect
                    ? (
                        reviewResult.mastered
                            ? "정답입니다! 이 약점을 극복했습니다. 🎉"
                            : `정답입니다! 다음 복습은 ${reviewResult.schedule.intervalDays}일 후에 진행됩니다.`
                    )
                    : "아쉽게 틀렸습니다. 이 약점은 1일 후에 다시 복습합니다.",

            reviewResult:
                attempt.reviewResult,

            dashboard:
                buildDashboard(user)
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error:
                "예약 복습 채점 중 서버 오류가 발생했습니다."
        });
    }
});


app.post("/api/notes/check", requireAuth, async (req, res) => {
    try {
        const {
    subject,
    problem,
    userAnswer,
    correctAnswer,

    // 사진 문제 식별용
    problemImageKey = "",

    currentAnalysis,
    sourceType = "normal",
    generatedProblemId,

    // ScorePath 학습 컨텍스트
    examId = "",
    unit = ""
} = req.body;

const user = req.currentUser;
ensureUserShape(user);

const cleanSubject = safeText(subject);
const cleanProblem = safeText(problem);
const cleanProblemImageKey = safeText(problemImageKey);

// =====================================
// ScorePath 21-90
// 사진 문제 존재 여부 확인
// =====================================

const hasProblemImage =
    Boolean(cleanProblemImageKey);

const cleanUserAnswer = safeText(userAnswer);

// ScorePath 학습 컨텍스트
const cleanExamId = safeText(examId);
const cleanUnit = safeText(unit);

// =====================================
// ScorePath 21-240
// 진행 중 학습의 잘못된 풀이 연결 차단
// =====================================

const activeLearning =
    Array.isArray(user.scorePathStudySessions)
        ? user.scorePathStudySessions.find(
            (item) => item.status === "in_progress"
        )
        : null;

// =====================================
// ScorePath 21-290
// 동시 활성 학습 세션 충돌 보호
// =====================================

const conflictingGeneralStudy =
    Array.isArray(user.scorePathGeneralSessions)
        ? user.scorePathGeneralSessions.find(
            item => item.status === "in_progress"
        )
        : null;

if (
    sourceType === "normal" &&
    activeLearning &&
    conflictingGeneralStudy
) {

    return res.status(409).json({

        error:
            "일반 공부와 시험 공부가 동시에 진행 중입니다. " +
            "문제 기록을 보호하기 위해 제출을 중단했습니다. " +
            "두 공부 중 하나를 완료하거나 취소해주세요."
    });
}


// =====================================
// 기존 시험 공부 기록 검사 유지
// =====================================

if (sourceType === "normal" && activeLearning) {

    const activeExam =
        user.examPlans?.[activeLearning.examId];

    if (
        !activeExam ||
        cleanExamId !== safeText(activeLearning.examId) ||
        cleanUnit !== safeText(activeLearning.unit) ||
        cleanSubject !== safeText(activeExam.subject)
    ) {

        return res.status(409).json({
            error:
                "진행 중인 공부의 시험·과목·단원과 " +
                "현재 문제 입력이 다릅니다. " +
                "학습 화면에서 선택을 확인해 주세요."
        });
    }
}


// =====================================
// ScorePath 21-281
// 일반 공부 기록 연결 검증
// =====================================

// =====================================
// 1. 진행 중인 일반 공부 확인
// =====================================

const activeGeneralLearning =
    Array.isArray(user.scorePathGeneralSessions)

        ? user.scorePathGeneralSessions.find(
            (item) =>
                item.status === "in_progress"
        )

        : null;


// =====================================
// 2. 일반 문제풀이 기록 검사
// =====================================

if (
    sourceType === "normal" &&
    activeGeneralLearning
) {

    // =====================================
    // 실제 진행 중인 공부와 비교
    // =====================================

    if (

        // 진행 중인 일반 공부에 시험 연결 금지
        cleanExamId ||

        // 과목 불일치
        cleanSubject !==
            safeText(activeGeneralLearning.subject) ||

        // 단원 불일치
        cleanUnit !==
            safeText(activeGeneralLearning.unit)

    ) {

        return res.status(409).json({

            error:
                "진행 중인 일반 공부와 과목·단원이 다릅니다. " +
                "기존 일반 공부를 완료하거나 취소한 뒤 변경해주세요."
        });
    }
}


// =====================================
// 기존 시험 컨텍스트 서버 검증
// =====================================

// =====================================
// ScorePath - 시험 컨텍스트 서버 검증
// =====================================

if (cleanExamId) {

    const selectedExam =
        user.examPlans?.[cleanExamId];


    // 존재하지 않는 시험 ID
    if (!selectedExam) {
        return res.status(400).json({
            message:
                "연결한 시험 정보를 찾을 수 없습니다."
        });
    }


    const examSubject =
        safeText(
            selectedExam.subject
        );

    const examRange =
        Array.isArray(
            selectedExam.examRange
        )
            ? selectedExam.examRange
                .map((item) =>
                    safeText(item)
                )
                .filter(Boolean)
            : [];


    // =====================================
    // 문제 과목 = 시험 과목인지 확인
    // =====================================

    if (
        examSubject &&
        cleanSubject !== examSubject
    ) {
        return res.status(400).json({
            message:
                `선택한 시험은 '${examSubject}' 과목입니다.`
        });
    }


    // =====================================
    // 시험을 연결했다면 범위 선택 필수
    // =====================================

    if (!cleanUnit) {
        return res.status(400).json({
            message:
                "현재 학습 범위를 선택해주세요."
        });
    }


    // =====================================
    // 선택한 단원이 실제 시험범위인지 확인
    // =====================================

    if (
        !examRange.includes(
            cleanUnit
        )
    ) {
        return res.status(400).json({
            message:
                "선택한 학습 범위가 이 시험의 시험 범위에 포함되어 있지 않습니다."
        });
    }
}

const problemIdentity =
    getProblemIdentity(
        cleanProblem,
        cleanProblemImageKey
    );

let cleanCorrectAnswer = safeText(correctAnswer);

// =====================================
// ScorePath 21-247
// 유사문제는 서버에서 정답 확인
// =====================================

if (
    !cleanSubject ||
    (!cleanProblem && !hasProblemImage) ||
    !cleanUserAnswer ||
    (
        sourceType !== "similar" &&
        !cleanCorrectAnswer
    )
) {
    return res.status(400).json({
        error:
            "과목, 문제 또는 문제 사진, 내 답, 정답을 모두 입력해주세요."
    });
}

// 유사문제는 정답을 브라우저에서 받지 않고 서버에서 찾는다.
if (sourceType === "similar") {
    const cleanGeneratedProblemId = safeText(generatedProblemId);

    if (!cleanGeneratedProblemId) {
        return res.status(400).json({
            error: "유사문제 식별 정보가 없습니다."
        });
    }

    const hiddenSimilar =
        user.similarAnswerMap[cleanGeneratedProblemId];

    if (!hiddenSimilar) {
        return res.status(400).json({
            error: "유사문제의 정답 정보를 찾을 수 없습니다."
        });
    }

    // ID를 다른 문제에 붙여 보내는 것 방지
    if (safeText(hiddenSimilar.problem) !== cleanProblem) {
        return res.status(400).json({
            error: "유사문제 정보가 일치하지 않습니다."
        });
    }

    const generatedAnswer =
    safeText(hiddenSimilar.generatedAnswer);

if (!generatedAnswer) {
    return res.status(400).json({
        error: "유사문제의 생성 정답 정보가 없습니다."
    });
}

// =====================================
// ScorePath 21-350
// 유사문제 정답 확인은 저장된 정답으로만 처리한다.
// 정답 확인 클릭만으로 Gemini/GPT를 호출하지 않는다.
// =====================================

const hasPreviousVerification =
    hiddenSimilar.verificationStatus === "verified" &&
    Boolean(safeText(hiddenSimilar.verifiedAnswer));

cleanCorrectAnswer = hasPreviousVerification
    ? safeText(hiddenSimilar.verifiedAnswer)
    : generatedAnswer;

// generatedAnswer는 AI가 생성한 값이다.
// 독립 검증된 것으로 표시하거나 상태를 변경하지 않는다.

console.log("SIMILAR ANSWER CHECK (NO AI):", {
    generatedProblemId: cleanGeneratedProblemId,
    answerSource: hasPreviousVerification
        ? "previously_verified"
        : "generated_unverified"
});

}

// 일반/응용문제는 기존 방식
if (!cleanCorrectAnswer) {
    return res.status(400).json({
        error: "정답 정보가 없습니다."
    });
}

        const mathCheck = validateSimpleMathConsistency(cleanProblem, cleanCorrectAnswer);
        if (mathCheck.detectable && !mathCheck.isValid) {
            return res.status(400).json({
                error: `입력한 정답이 문제와 맞지 않을 수 있습니다. 이 문제의 계산상 정답은 ${mathCheck.expected} 입니다.`
            });
        }

        const identity = noteKey(
    cleanSubject,
    problemIdentity,
    cleanCorrectAnswer
);

        if (
    answersEquivalent(
        cleanUserAnswer,
        cleanCorrectAnswer,
        cleanProblem
    )
) {
    const cleanGeneratedProblemId =
        safeText(generatedProblemId);

    const hiddenSimilar =
        sourceType === "similar" && cleanGeneratedProblemId
            ? user.similarAnswerMap[cleanGeneratedProblemId]
            : null;

    // 같은 유사문제의 정답 성공 처리가 이미 끝났다면
    // DB / reviewCount / learningEvent를 다시 변경하지 않는다.
    if (
        sourceType === "similar" &&
        hiddenSimilar?.correctProcessed === true
    ) {
        console.log(
            "DUPLICATE SIMILAR CORRECT REQUEST SKIPPED:",
            {
                generatedProblemId:
                    cleanGeneratedProblemId,
                problem: cleanProblem,
                solvedNoteId:
                    hiddenSimilar.solvedNoteId || ""
            }
        );

        return res.json({
            isCorrect: true,
            duplicate: true,
            message: "이미 정답 처리된 유사문제입니다.",
            clearInputs: false,
            dashboard: buildDashboard(user)
        });
    }

        // =====================================
    // ScorePath 21-91
    // 사진과 텍스트 문제 식별 기준 통일
    // =====================================

    const identity =
        noteKey(
            cleanSubject,
            problemIdentity,
            cleanCorrectAnswer
        );

    // 정답과 오답 모두 저장 건수에 포함한다. 기존 저장 문제는 계속 풀 수 있다.
    if (!canStoreProblemV01(user, identity)) {
        return res.status(403).json({
            error: storedProblemLimitMessageV01(user),
            reason: "problem_storage_limit"
        });
    }

    const wrongIndex =
    user.notes.findIndex(
        (note) =>
            noteKey(
                note.subject,
                getProblemIdentity(
                    note.problem,
                    note.problemImageKey
                ),
                note.correctAnswer
            ) === identity
    );

    const generatedWeaknessSource =
        sourceType === "similar" &&
        hiddenSimilar
            ? (hiddenSimilar.weaknessSource || {})
            : {};

    let baseNote = {
        id: randomUUID(),

        subject:
            generatedWeaknessSource.subject ||
            cleanSubject,

                unit:
            cleanUnit ||
            generatedWeaknessSource.unit ||
            currentAnalysis?.unit ||
            "",

        // =====================================
        // ScorePath 21-87
        // 기존 사진 문제의 R2 저장 키 보존
        // =====================================

        problemImageKey:
            cleanProblemImageKey,

        difficulty:
            generatedWeaknessSource.difficulty ||
            currentAnalysis?.difficulty ||
            "",

        problem: cleanProblem,
        userAnswer: cleanUserAnswer,
        correctAnswer: cleanCorrectAnswer,

        weakConcept:
            generatedWeaknessSource.weakConcept ||
            currentAnalysis?.weakConcept ||
            "",

        weakConceptDetail:
            generatedWeaknessSource.weakConceptDetail ||
            currentAnalysis?.weakConceptDetail ||
            "",

        errorType:
            generatedWeaknessSource.errorType ||
            currentAnalysis?.errorType ||
            "",

        errorDetail:
            generatedWeaknessSource.errorDetail ||
            currentAnalysis?.errorDetail ||
            "",

        problemType:
            generatedWeaknessSource.problemType ||
            currentAnalysis?.problemType ||
            "",

        reason:
            currentAnalysis?.reason || "",

        concept:
            currentAnalysis?.concept || "",

        solution:
            currentAnalysis?.solution || "",

        similarProblems:
            Array.isArray(currentAnalysis?.similarProblems)
                ? currentAnalysis.similarProblems
                : [],

        advancedProblem:
            currentAnalysis?.advancedProblem || "",

        sourceType,

        reviewCount:
            sourceType === "similar" ||
            sourceType === "advanced"
                ? 1
                : 0,

        repeatWrongCount: 0,

        latestReviewResult: "correct",
        masteryStatus: "learning",

        createdAt: now(),
        updatedAt: now()
    };

    if (wrongIndex !== -1) {
        baseNote = user.notes[wrongIndex];

        user.notes.splice(
            wrongIndex,
            1
        );
    }

    const solvedNote = {
        ...baseNote,

        userAnswer: cleanUserAnswer,

        reviewCount:
            wrongIndex !== -1
                ? (baseNote.reviewCount || 0) + 1
                : (
                    sourceType === "similar" ||
                    sourceType === "advanced"
                        ? Math.max(
                            Number(baseNote.reviewCount || 0),
                            1
                        )
                        : (baseNote.reviewCount || 0)
                ),

        latestReviewResult: "correct",
        masteryStatus: "learning",

        updatedAt: now(),
        solvedAt: now()
    };

    const solvedIndex =
    user.solvedNotes.findIndex(
        (note) =>
            noteKey(
                note.subject,
                getProblemIdentity(
                    note.problem,
                    note.problemImageKey
                ),
                note.correctAnswer
            ) === identity
    );

    if (solvedIndex !== -1) {
        const existingSolved =
            user.solvedNotes[solvedIndex];

        user.solvedNotes[solvedIndex] = {
            ...existingSolved,
            ...solvedNote,

            reviewCount:
                wrongIndex !== -1
                    ? solvedNote.reviewCount
                    : Math.max(
                        Number(existingSolved.reviewCount || 0),
                        Number(solvedNote.reviewCount || 0)
                    ),

            repeatWrongCount:
                wrongIndex !== -1
                    ? solvedNote.repeatWrongCount
                    : (existingSolved.repeatWrongCount || 0)
        };
    } else {
        user.solvedNotes.push(solvedNote);
    }

        // =====================================
    // ScorePath 21-89
    // 텍스트 + 사진 문제 식별 방식 통일
    // =====================================

    const weaknessEventNote =
        user.solvedNotes.find(
            (note) =>
                noteKey(
                    note.subject,
                    getProblemIdentity(
                        note.problem,
                        note.problemImageKey
                    ),
                    note.correctAnswer
                ) === identity
        );

    recordLearningEvent(
        user,
        weaknessEventNote,
        "correct",
        sourceType === "normal"
            ? "review"
            : "retraining",
        sourceType
    );


    // =====================================
    // ScorePath - 전체 풀이 기록
    // 정답도 반드시 학습 데이터로 저장한다.
    // =====================================

    recordProblemHistory(
    user,
    {
        examId:
            cleanExamId,

        subject:
            weaknessEventNote?.subject ||
            cleanSubject,

        unit:
            cleanUnit ||
            weaknessEventNote?.unit ||
            currentAnalysis?.unit ||
            "",

            problem:
                cleanProblem,

            problemImageKey:
                weaknessEventNote?.problemImageKey ||
                "",

            userAnswer:
                cleanUserAnswer,

            correctAnswer:
                cleanCorrectAnswer,

            isCorrect: true,

            difficulty:
                weaknessEventNote?.difficulty ||
                currentAnalysis?.difficulty ||
                "",

            problemType:
                weaknessEventNote?.problemType ||
                currentAnalysis?.problemType ||
                "",

            sourceType,

            source:
                sourceType === "similar"
                    ? "similar_problem"
                    : sourceType === "advanced"
                    ? "advanced_problem"
                    : "answer_check"
        }
    );


    // 유사문제라면 여기까지 성공한 뒤에만
    // 정답 성공 처리 완료 표시
    if (
        sourceType === "similar" &&
        hiddenSimilar
    ) {
        hiddenSimilar.correctProcessed = true;
        hiddenSimilar.correctProcessedAt = now();
        hiddenSimilar.solvedNoteId =
            safeText(weaknessEventNote?.id);
    }

    refreshWeaknessSystem(user);

    writeDb(req.db);

    return res.json({
        isCorrect: true,
        duplicate: false,

        message:
            sourceType === "normal"
                ? "정답입니다. 복습완료로 이동했습니다."
                : "추가 문제를 맞혔습니다. 복습완료로 이동했습니다.",

        clearInputs:
            sourceType !== "similar",

        dashboard:
            buildDashboard(user)
    });
}

        const existingIndex = user.notes.findIndex(
    (note) =>
        noteKey(
            note.subject,
            getProblemIdentity(
                note.problem,
                note.problemImageKey
            ),
            note.correctAnswer
        ) === identity
);
        const rule = getPlanRule(user.plan);

const solvedWrongIndex = user.solvedNotes.findIndex(
    (note) =>
        noteKey(
            note.subject,
            getProblemIdentity(
                note.problem,
                note.problemImageKey
            ),
            note.correctAnswer
        ) === identity
);

if (existingIndex === -1 && solvedWrongIndex !== -1) {
    const previousSolved = user.solvedNotes[solvedWrongIndex];

    const restoredNote = {
        ...previousSolved,

        userAnswer: cleanUserAnswer,

        weakConcept:
            currentAnalysis?.weakConcept ||
            previousSolved.weakConcept ||
            "",

        errorType:
            currentAnalysis?.errorType ||
            previousSolved.errorType ||
            "",

        problemType:
            currentAnalysis?.problemType ||
            previousSolved.problemType ||
            "",

        reason:
            currentAnalysis?.reason ||
            previousSolved.reason ||
            "정답과 다른 답입니다.",

        concept:
            currentAnalysis?.concept ||
            previousSolved.concept ||
            "",

        solution:
            currentAnalysis?.solution ||
            previousSolved.solution ||
            "",

        similarProblems:
            Array.isArray(currentAnalysis?.similarProblems)
                ? currentAnalysis.similarProblems
                : (previousSolved.similarProblems || []),

        advancedProblem:
            currentAnalysis?.advancedProblem ||
            previousSolved.advancedProblem ||
            "",

        sourceType,

        reviewCount: previousSolved.reviewCount || 0,

        repeatWrongCount:
            (previousSolved.repeatWrongCount || 0) + 1,

        latestReviewResult: "wrong",
        masteryStatus: "learning",

        createdAt: previousSolved.createdAt,
        updatedAt: now()
    };

        user.notes.push(restoredNote);
    user.solvedNotes.splice(solvedWrongIndex, 1);

            // 해결했던 문제를 다시 틀린 실제 이벤트 기록
    recordLearningEvent(
        user,
        restoredNote,
        "wrong",
        "retry",
        sourceType
    );

    // =====================================
    // ScorePath 21-246
    // 다시 틀린 문제도 전체 풀이 기록에 저장
    // =====================================

    recordProblemHistory(user, {
        examId: cleanExamId,

        subject: cleanSubject,

        unit:
            cleanUnit ||
            restoredNote.unit ||
            "",

        problem: cleanProblem,

        problemImageKey:
            cleanProblemImageKey ||
            restoredNote.problemImageKey ||
            "",

        userAnswer: cleanUserAnswer,

        correctAnswer: cleanCorrectAnswer,

        isCorrect: false,

        difficulty:
            restoredNote.difficulty ||
            "",

        problemType:
            restoredNote.problemType ||
            "",

        sourceType,

        source:
            sourceType === "similar"
                ? "similar_problem"
                : sourceType === "advanced"
                    ? "advanced_problem"
                    : "answer_check"
    });

    // 약점 프로필 + 복습 스케줄 동기화
    refreshWeaknessSystem(user);

    writeDb(req.db);

    return res.json({
        isCorrect: false,

        message:
            sourceType === "similar"
                ? "유사문제를 다시 틀렸습니다. 오답노트로 이동했습니다."
                : sourceType === "advanced"
                ? "응용문제를 다시 틀렸습니다. 오답노트로 이동했습니다."
                : "다시 틀렸습니다. 오답노트로 이동했습니다.",

        clearInputs: false,
        dashboard: buildDashboard(user)
    });
}

        if (existingIndex === -1 && rule.storageLimit !== Infinity &&
            getStoredProblemCountV01(user) >= rule.storageLimit) {
            return res.status(403).json({
                error: storedProblemLimitMessageV01(user)
            });
        }

        const wrongGeneratedWeaknessSource =
    sourceType === "similar" &&
    safeText(generatedProblemId) &&
    user.similarAnswerMap[safeText(generatedProblemId)]
        ? (
            user.similarAnswerMap[safeText(generatedProblemId)]
                .weaknessSource || {}
        )
        : {};

const existingWrongNote =
    existingIndex !== -1
        ? user.notes[existingIndex]
        : null;

const updatedNote = {
    id:
        existingWrongNote?.id ||
        randomUUID(),

    subject:
        wrongGeneratedWeaknessSource.subject ||
        cleanSubject,

        unit:
        cleanUnit ||
        wrongGeneratedWeaknessSource.unit ||
        currentAnalysis?.unit ||
        existingWrongNote?.unit ||
        "",

    // =====================================
    // ScorePath 21-88
    // 오답 기록의 사진 연결 유지
    // =====================================

    problemImageKey:
        cleanProblemImageKey ||
        existingWrongNote?.problemImageKey ||
        "",

    problem: cleanProblem,
    userAnswer: cleanUserAnswer,
    correctAnswer: cleanCorrectAnswer,

    weakConcept:
        wrongGeneratedWeaknessSource.weakConcept ||
        currentAnalysis?.weakConcept ||
        existingWrongNote?.weakConcept ||
        "",

    weakConceptDetail:
        wrongGeneratedWeaknessSource.weakConceptDetail ||
        currentAnalysis?.weakConceptDetail ||
        existingWrongNote?.weakConceptDetail ||
        "",

    errorType:
        wrongGeneratedWeaknessSource.errorType ||
        currentAnalysis?.errorType ||
        existingWrongNote?.errorType ||
        "",

    errorDetail:
        wrongGeneratedWeaknessSource.errorDetail ||
        currentAnalysis?.errorDetail ||
        existingWrongNote?.errorDetail ||
        "",

    problemType:
        wrongGeneratedWeaknessSource.problemType ||
        currentAnalysis?.problemType ||
        existingWrongNote?.problemType ||
        "",

    difficulty:
        wrongGeneratedWeaknessSource.difficulty ||
        currentAnalysis?.difficulty ||
        existingWrongNote?.difficulty ||
        "",

    reason:
        currentAnalysis?.reason ||
        existingWrongNote?.reason ||
        "정답과 다른 답입니다.",

    concept:
        currentAnalysis?.concept ||
        existingWrongNote?.concept ||
        "핵심 개념을 다시 확인해야 합니다.",

    solution:
        currentAnalysis?.solution ||
        existingWrongNote?.solution ||
        "풀이 순서를 짧게 적고 다시 풀어보세요.",

    similarProblems:
        Array.isArray(currentAnalysis?.similarProblems)
            ? currentAnalysis.similarProblems
            : (existingWrongNote?.similarProblems || []),

    advancedProblem:
        currentAnalysis?.advancedProblem ||
        existingWrongNote?.advancedProblem ||
        "",

    sourceType,

    // 틀렸다고 복습 성공 횟수를 올리지 않는다.
    reviewCount:
        existingWrongNote?.reviewCount || 0,

    repeatWrongCount: (() => {
        if (!existingWrongNote) return 1;

        const previousCount = Math.max(
            1,
            Number(existingWrongNote.repeatWrongCount) || 0
        );

        // AI 분석으로만 먼저 만들어진 오답은
        // 아직 정답확인 풀이 기록이 없을 수 있다.
        const hadEarlierWrongCheck = (
            Array.isArray(user.problemHistory)
                ? user.problemHistory
                : []
        ).some((item) =>
            item.isCorrect === false &&
            safeText(item.subject) === cleanSubject &&
            getProblemIdentity(
                item.problem,
                item.problemImageKey
            ) === problemIdentity &&
            Number(item.solvedAt || item.createdAt || 0) >=
                Number(existingWrongNote.createdAt || 0)
        );

        return hadEarlierWrongCheck
            ? previousCount + 1
            : previousCount;
    })(),

    latestReviewResult: "wrong",
    masteryStatus: "learning",

    createdAt:
        existingWrongNote?.createdAt ||
        now(),

    updatedAt: now()
};

                if (existingIndex !== -1) {
            user.notes[existingIndex] = updatedNote;
        } else {
            user.notes.push(updatedNote);
        }

                        // 실제 오답 발생 순서를 기록한다.
        // 실제 오답 발생 순서를 기록한다.
recordLearningEvent(
    user,
    updatedNote,
    "wrong",
    existingIndex === -1
        ? "initial"
        : "retry",
    sourceType
);


// =====================================
// ScorePath - 전체 풀이 기록
// 틀린 문제도 반드시 학습 데이터로 저장한다.
// =====================================

recordProblemHistory(
    user,
    {
        examId:
            cleanExamId,

        subject:
            updatedNote.subject ||
            cleanSubject,

        unit:
            cleanUnit ||
            updatedNote.unit ||
            currentAnalysis?.unit ||
            "",

        problem:
            cleanProblem,

        problemImageKey:
            updatedNote.problemImageKey ||
            "",

        userAnswer:
            cleanUserAnswer,

        correctAnswer:
            cleanCorrectAnswer,

        isCorrect: false,

        difficulty:
            updatedNote.difficulty ||
            currentAnalysis?.difficulty ||
            "",

        problemType:
            updatedNote.problemType ||
            currentAnalysis?.problemType ||
            "",

        sourceType,

        source:
            sourceType === "similar"
                ? "similar_problem"
                : sourceType === "advanced"
                ? "advanced_problem"
                : "answer_check"
    }
);


// 약점 프로필 + 복습 스케줄 동기화
        refreshWeaknessSystem(user);

        writeDb(req.db);

        return res.json({
            isCorrect: false,

            message:
                sourceType === "similar"
                    ? "유사문제를 틀렸습니다. 저장했습니다."
                    : sourceType === "advanced"
                    ? "응용문제를 틀렸습니다. 저장했습니다."
                    : "틀렸습니다. 오답노트에 저장했습니다.",

            clearInputs: false,
            dashboard: buildDashboard(user)
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "정답 확인 중 서버 오류가 발생했습니다." });
    }
});

app.post("/api/notes/delete", requireAuth, (req, res) => {
    const { id } = req.body;
    const user = req.currentUser;

    ensureUserShape(user);

    const note = user.notes.find((item) => item.id === id);

    if (!note) {
        return res.status(404).json({
            error: "삭제할 오답을 찾을 수 없습니다."
        });
    }

    user.trashNotes.push({
        ...note,
        trashFrom: "wrong",
        deletedAt: now()
    });

    user.notes = user.notes.filter((item) => item.id !== id);

    writeDb(req.db);

    return res.json({
        message: "오답을 휴지통으로 이동했습니다.",
        dashboard: buildDashboard(user)
    });
});

app.post("/api/notes/clear", requireAuth, (req, res) => {
    const user = req.currentUser;
    ensureUserShape(user);

    if (user.notes.length === 0) {
        return res.json({
            message: "삭제할 오답이 없습니다.",
            dashboard: buildDashboard(user)
        });
    }

    const deletedAt = now();

    user.trashNotes.push(
        ...user.notes.map((note) => ({
            ...note,
            trashFrom: "wrong",
            deletedAt
        }))
    );

    user.notes = [];

    writeDb(req.db);

    return res.json({
        message: "오답 리스트를 휴지통으로 이동했습니다.",
        dashboard: buildDashboard(user)
    });
});

app.post("/api/solved/delete", requireAuth, (req, res) => {
    const { id } = req.body;
    const user = req.currentUser;

    ensureUserShape(user);

    const note = user.solvedNotes.find((item) => item.id === id);

    if (!note) {
        return res.status(404).json({
            error: "삭제할 복습완료 문제를 찾을 수 없습니다."
        });
    }

    user.trashNotes.push({
        ...note,
        trashFrom: "solved",
        deletedAt: now()
    });

    user.solvedNotes =
        user.solvedNotes.filter((item) => item.id !== id);

    writeDb(req.db);

    return res.json({
        message: "복습완료 문제를 휴지통으로 이동했습니다.",
        dashboard: buildDashboard(user)
    });
});

app.post("/api/solved/clear", requireAuth, (req, res) => {
    const user = req.currentUser;
    ensureUserShape(user);

    if (user.solvedNotes.length === 0) {
        return res.json({
            message: "삭제할 복습완료 문제가 없습니다.",
            dashboard: buildDashboard(user)
        });
    }

    const deletedAt = now();

    user.trashNotes.push(
        ...user.solvedNotes.map((note) => ({
            ...note,
            trashFrom: "solved",
            deletedAt
        }))
    );

    user.solvedNotes = [];

    writeDb(req.db);

    return res.json({
        message: "복습완료 리스트를 휴지통으로 이동했습니다.",
        dashboard: buildDashboard(user)
    });
});

app.post("/api/trash/restore", requireAuth, (req, res) => {
    const { id } = req.body;
    const user = req.currentUser;

    ensureUserShape(user);

    const trashNote =
        user.trashNotes.find((item) => item.id === id);

    if (!trashNote) {
        return res.status(404).json({
            error: "휴지통에서 문제를 찾을 수 없습니다."
        });
    }

    const {
        trashFrom,
        deletedAt,
        ...restoredNote
    } = trashNote;

    // 정답/오답 복구 모두 같은 저장 한도를 사용한다.
    const restoredIdentityV01 = noteKey(
        restoredNote.subject,
        getProblemIdentity(restoredNote.problem, restoredNote.problemImageKey),
        restoredNote.correctAnswer
    );
    if (!canStoreProblemV01(user, restoredIdentityV01)) {
        return res.status(403).json({
            error: storedProblemLimitMessageV01(user),
            reason: "problem_storage_limit"
        });
    }

    if (trashFrom === "wrong") {
        const exists = user.notes.some(
    (item) =>
        noteKey(
            item.subject,
            getProblemIdentity(
                item.problem,
                item.problemImageKey
            ),
            item.correctAnswer
        ) ===
        noteKey(
            restoredNote.subject,
            getProblemIdentity(
                restoredNote.problem,
                restoredNote.problemImageKey
            ),
            restoredNote.correctAnswer
        )
);

        const rule = getPlanRule(user.plan);

        if (
            !exists &&
            rule.storageLimit !== Infinity &&
            getStoredProblemCountV01(user) >= rule.storageLimit &&
            !isAlreadyStoredProblemV01(user, restoredIdentityV01)
        ) {
            return res.status(403).json({
                error: storedProblemLimitMessageV01(user)
            });
        }

        if (!exists && !isAlreadyStoredProblemV01(user, restoredIdentityV01)) {
            user.notes.push(restoredNote);
        }

    } else if (trashFrom === "solved") {

        const exists = user.solvedNotes.some(
    (item) =>
        noteKey(
            item.subject,
            getProblemIdentity(
                item.problem,
                item.problemImageKey
            ),
            item.correctAnswer
        ) ===
        noteKey(
            restoredNote.subject,
            getProblemIdentity(
                restoredNote.problem,
                restoredNote.problemImageKey
            ),
            restoredNote.correctAnswer
        )
);

        if (!exists && !isAlreadyStoredProblemV01(user, restoredIdentityV01)) {
            user.solvedNotes.push(restoredNote);
        }

    } else {
        return res.status(400).json({
            error: "원래 위치를 확인할 수 없습니다."
        });
    }

    user.trashNotes =
        user.trashNotes.filter((item) => item.id !== id);

    writeDb(req.db);

    return res.json({
        message:
            trashFrom === "wrong"
                ? "오답 리스트로 복구했습니다."
                : "복습완료 리스트로 복구했습니다.",
        dashboard: buildDashboard(user)
    });
});

app.post(
    "/api/trash/delete",
    requireAuth,
    async (req, res) => {
        try {
            const { id } =
                req.body;

            const user =
                req.currentUser;

            ensureUserShape(user);

            const note =
                user.trashNotes.find(
                    (item) =>
                        item.id === id
                );

            if (!note) {
                return res
                    .status(404)
                    .json({
                        error:
                            "영구삭제할 문제를 찾을 수 없습니다."
                    });
            }

            await permanentlyCleanupNote(
                user,
                note
            );

            user.trashNotes =
                user.trashNotes.filter(
                    (item) =>
                        item.id !== id
                );

            writeDb(req.db);

            return res.json({
                message:
                    "문제를 영구삭제했습니다.",

                dashboard:
                    buildDashboard(
                        user
                    )
            });

        } catch (error) {
            console.error(
                "TRASH PERMANENT DELETE ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        error.message ||
                        "문제 영구삭제에 실패했습니다."
                });
        }
    }
);


app.post(
    "/api/trash/clear",
    requireAuth,
    async (req, res) => {
        try {
            const user =
                req.currentUser;

            ensureUserShape(user);

            for (
                const note of
                user.trashNotes
            ) {
                await permanentlyCleanupNote(
                    user,
                    note
                );
            }

            user.trashNotes = [];

            writeDb(req.db);

            return res.json({
                message:
                    "휴지통을 비웠습니다.",

                dashboard:
                    buildDashboard(
                        user
                    )
            });

        } catch (error) {
            console.error(
                "TRASH CLEAR ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        error.message ||
                        "휴지통 비우기에 실패했습니다."
                });
        }
    }
);

app.post("/api/solved/restore", requireAuth, (req, res) => {
    const { id } = req.body;
    const user = req.currentUser;
    ensureUserShape(user);

    const note = user.solvedNotes.find((item) => item.id === id);
    if (!note) {
        return res.status(404).json({ error: "복습완료 문제를 찾을 수 없습니다." });
    }

   const exists = user.notes.some(
    (item) =>
        noteKey(
            item.subject,
            getProblemIdentity(
                item.problem,
                item.problemImageKey
            ),
            item.correctAnswer
        ) ===
        noteKey(
            note.subject,
            getProblemIdentity(
                note.problem,
                note.problemImageKey
            ),
            note.correctAnswer
        )
);
    // 복습완료 -> 오답 목록 이동은 저장 총 건수를 늘리지 않는다.
    if (!exists) {
        user.notes.push({
            ...note,
            createdAt: now(),
            updatedAt: now()
        });
    }

    user.solvedNotes = user.solvedNotes.filter((item) => item.id !== id);
    writeDb(req.db);

    return res.json({
        message: "복습완료 문제를 오답으로 복원했습니다.",
        dashboard: buildDashboard(user)
    });
});




// =====================================
// ScorePath pre-PG: 결제/내역 API를 SPA 라우팅보다 먼저 등록
// =====================================
installCommerce(app, {
    dataDir, requireAuth, readDb, writeDb, bcrypt,
    r2Client, DeleteObjectCommand
});

// API 오타가 성공 HTML로 표시되는 것을 방지
app.use("/api", (req, res) => {
    return res.status(404).json({ error: "API 경로를 찾을 수 없습니다." });
});

// 호스팅 준비 상태: 개인 정보/DB 내용을 노출하지 않음
app.get("/healthz", (req, res) => {
    try {
        if (!scorePathNeon) {
            const stat = fs.statSync(dbPath);
            if (!stat.isFile() || stat.size === 0) throw new Error("database missing");
        }
        // Neon was already checked when starting; don't wake a sleeping DB on each health request.
        return res.status(200).json({ status: "ok" });
    } catch {
        return res.status(503).json({ status: "unhealthy" });
    }
});

// 일반 웹 화면은 API 등록 후에 처리
app.get("*", (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://0.0.0.0:${PORT}`);
});