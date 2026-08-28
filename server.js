
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;

console.log("API KEY 확인:", apiKey ? "불러오기 성공" : "불러오기 실패");
import session from "express-session";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
let aiStats = {
    total: 0,
    mediumUsed: 0
};
console.log("🔥 서버 새 버전 실행");
const PORT = Number(process.env.PORT || 3000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "db.json");

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({ users: [] }, null, 2), "utf-8");
}

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
    session({
        secret: process.env.SESSION_SECRET || "super_secret_key_123456789",
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: false,
            maxAge: 1000 * 60 * 60 * 24 * 7
        }
    })
);

const DEFAULT_SUBJECTS = ["국어", "영어", "수학", "사회", "과학"];

app.use(express.static(publicDir));

const PLAN_RULES = {
    free: {
        aiDaily: 5,
        storageLimit: 50,
        similarCount: 1,
        reviewEnabled: false,
        duplicateAnalyze: false,
        advancedEnabled: false
    },
    premium5900: {
        aiDaily: 20,
        storageLimit: 300,
        similarCount: 2,
        reviewEnabled: true,
        duplicateAnalyze: true,
        advancedEnabled: false
    },
    premium8900: {
        aiDaily: 40,
        storageLimit: Infinity,
        similarCount: 3,
        reviewEnabled: true,
        duplicateAnalyze: true,
        advancedEnabled: true
    }
};

function safeText(value) {
    return String(value || "").trim();
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

    const symbols = ["①", "②", "③", "④", "⑤"];
    const map = {};

    for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];

        const start = text.indexOf(symbol);
        if (start === -1) continue;

        let end = text.length;

        for (let j = i + 1; j < symbols.length; j++) {
            const next = text.indexOf(symbols[j], start + 1);

            if (next !== -1) {
                end = next;
                break;
            }
        }

        let value = text
            .slice(start + symbol.length, end)
            .trim();

        // 줄바꿈 뒤에 불필요한 내용이 붙는 경우 방지
        value = value.split("\n")[0].trim();

        if (value) {
            map[symbol] = value;
            map[String(i + 1)] = value;
            map[`${i + 1}번`] = value;
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
    const normalizedA = normalizeAnswer(a);
    const normalizedB = normalizeAnswer(b);

    if (!normalizedA || !normalizedB) {
        return false;
    }

    // 1. 기존 정규화만으로 같은 경우
    if (normalizedA === normalizedB) {
        return true;
    }

        // 숫자 ↔ 숫자+한국어 개수 단위 비교
    const koreanCounterA = parseNumberWithKoreanCounter(a);
    const koreanCounterB = parseNumberWithKoreanCounter(b);

    const plainNumberA =
        /^-?\d+(?:\.\d+)?$/.test(normalizedA)
            ? Number(normalizedA)
            : null;

    const plainNumberB =
        /^-?\d+(?:\.\d+)?$/.test(normalizedB)
            ? Number(normalizedB)
            : null;

    if (
        koreanCounterA &&
        plainNumberB !== null &&
        koreanCounterA.value === plainNumberB
    ) {
        return true;
    }

    if (
        koreanCounterB &&
        plainNumberA !== null &&
        koreanCounterB.value === plainNumberA
    ) {
        return true;
    }

    // 2. 단위 동치 비교
    const quantityA = parseComparableQuantity(a);
    const quantityB = parseComparableQuantity(b);

    if (
        quantityA &&
        quantityB &&
        quantityA.type === quantityB.type &&
        Math.abs(quantityA.value - quantityB.value) < 1e-9
    ) {
        return true;
    }

    // 3. 객관식 선택지 ↔ 실제 값 비교
    const choiceMap = getChoiceMap(problem);

    const rawA = safeText(a).trim();
    const rawB = safeText(b).trim();

    const choiceValueA = choiceMap[rawA];
    const choiceValueB = choiceMap[rawB];

    // A가 ①/1번 등이고 B가 실제 선택지 값
    if (
        choiceValueA &&
        answersEquivalent(choiceValueA, b, "")
    ) {
        return true;
    }

    // B가 ①/1번 등이고 A가 실제 선택지 값
    if (
        choiceValueB &&
        answersEquivalent(a, choiceValueB, "")
    ) {
        return true;
    }

    // 둘 다 선택지 표현
    if (
        choiceValueA &&
        choiceValueB &&
        answersEquivalent(choiceValueA, choiceValueB, "")
    ) {
        return true;
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
        comparableCorrectAnswer.match(/^([①②③④⑤])/);

    if (answerSymbolMatch) {
        const symbol = answerSymbolMatch[1];

        const matchedChoice = choices.find(
            (choice) => choice.symbol === symbol
        );

        if (matchedChoice) {
            comparableCorrectAnswer = matchedChoice.value;
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

function readDb() {
    try {
        const raw = fs.readFileSync(dbPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed.users || !Array.isArray(parsed.users)) {
            return { users: [] };
        }
        return parsed;
    } catch {
        return { users: [] };
    }
}

function writeDb(db) {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf-8");
}

function getPlanRule(plan) {
    return PLAN_RULES[plan] || PLAN_RULES.free;
}

function ensureUserShape(user) {
    if (!Array.isArray(user.notes)) user.notes = [];
    if (!Array.isArray(user.solvedNotes)) user.solvedNotes = [];
    if (!Array.isArray(user.trashNotes)) user.trashNotes = [];

    if (!user.analysisCache || typeof user.analysisCache !== "object") {
        user.analysisCache = {};
    }

    if (!user.advancedAnswerMap) {
        user.advancedAnswerMap = {};
    }

    if (!Array.isArray(user.subjects) || user.subjects.length === 0) {
    user.subjects = [...DEFAULT_SUBJECTS];
}

    if (!user.usageAi || user.usageAi.date !== todayString()) {
        user.usageAi = { date: todayString(), count: 0 };
    }
    if (!user.usageAdvanced || user.usageAdvanced.date !== todayString()) {
        user.usageAdvanced = { date: todayString(), count: 0, usedKeys: [] };
    }
    if (!Array.isArray(user.usageAdvanced.usedKeys)) {
        user.usageAdvanced.usedKeys = [];
    }
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

function noteKey(subject, problem, correctAnswer) {
    return `${subject}::${problem}::${correctAnswer}`;
}

function analysisKey(subject, problem, userAnswer, correctAnswer, plan) {
    return `${plan}::${subject}::${problem}::${userAnswer}::${correctAnswer}`;
}

function advancedProblemKey(subject, problem) {
    return `${subject}::${problem}`.toLowerCase();
}

function permanentlyCleanupNote(user, note) {
    if (!note) return;

    const cacheTarget =
        `::${note.subject}::${note.problem}::`;

    Object.keys(user.analysisCache || {}).forEach((key) => {
        if (key.includes(cacheTarget)) {
            delete user.analysisCache[key];
        }
    });

    const advancedKey =
        advancedProblemKey(note.subject, note.problem);

    user.usageAdvanced.usedKeys =
        (user.usageAdvanced.usedKeys || [])
            .filter((key) => key !== advancedKey);

    if (note.advancedProblem) {
        delete user.advancedAnswerMap[note.advancedProblem];
    }

    // 휴지통 항목 자체가 응용문제인 경우에도 정답 기록 제거
    if (note.sourceType === "advanced" && note.problem) {
        delete user.advancedAnswerMap[note.problem];
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
    const similarProblems = makeFallbackSimilarProblems(problem, getPlanRule(plan).similarCount);
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
${similarRoleGuide}

아래 JSON만 출력한다:
{
  "concept": "",
  "solution": "",
  ${similarJson}
}
`;
}

async function requestOpenAIAnswer(problem, apiKey) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
     model: "gpt-5.4-mini",

          response_format: {
    type: "json_object"
},

messages: [
    {
        role: "system",
        content: `
너는 문제의 실제 정답을 독립적으로 구하는 정답 검증 AI다.
학생의 답은 보지 않고 문제만 풀어라.

규칙:
1. 문제의 분야와 의도를 파악하고 적절한 공식·정의·조건을 적용한다.
2. 단순 계산뿐 아니라 단위, 조건, 수량의 의미를 정확히 구분한다.
3. 답을 구한 뒤 계산과 조건을 한 번 검산한다.
4. 공식 사용 시 변수와 문제의 수량이 올바르게 대응하는지 확인한다.
5. 전문 분야 문제는 일반 수학 공식을 기계적으로 적용하지 말고 해당 분야의 정의와 관계를 따른다.
6. 충분한 근거가 있을 때만 confident=true로 한다.
7. 확실하지 않으면 답을 추측하지 말고 confident=false로 한다.
`
    },
    {
        role: "user",
        content: `
[문제]
${problem}

문제를 처음부터 풀어 최종 정답을 구하고, 같은 문제를 다시 검산하여 checkAnswer를 결정해라.

규칙:
- aiAnswer에는 첫 계산의 최종 정답만 작성한다.
- checkAnswer에는 재검산한 최종 정답만 작성한다.
- 숫자 문제는 가능한 한 숫자와 필요한 단위만 작성한다.
- 두 결과를 억지로 같게 만들지 않는다.
- 두 결과가 다르거나 정답을 확정할 수 없으면 confident=false로 한다.
- 풀이와 설명은 출력하지 않는다.
- 반드시 JSON만 출력한다.

출력 형식:
{
  "aiAnswer": "",
  "checkAnswer": "",
  "confident": true
}
`
    }
],

// temperature: 0,
max_completion_tokens: 800
        })
    });

    const data = await response.json();
    console.log("ANSWER FINISH:", data?.choices?.[0]?.finish_reason);
console.log("ANSWER USAGE:", data?.usage);
console.log("ANSWER MESSAGE:", data?.choices?.[0]?.message);

    if (!response.ok) {
        throw new Error(JSON.stringify(data));
    }

    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error("정답 검증 AI의 응답이 없습니다.");
    }

    console.log("ANSWER RAW:", content);

    let parsed;

    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error("정답 검증 AI의 JSON 형식이 올바르지 않습니다.");
    }

return {
    aiAnswer: safeText(parsed.aiAnswer),
    checkAnswer: safeText(parsed.checkAnswer),
    confident: parsed.confident === true
};
}

async function requestOpenAIAnswerReview(problem, apiKey) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
           model: "gpt-5.4-mini",
          reasoning_effort: "medium",

           response_format: {
    type: "json_object"
},

            messages: [
                {
                    role: "system",
                    content: `
너는 시험 문제의 정답을 독립적으로 검산하는 AI다.

다른 AI가 어떤 답을 냈는지 알 수 없으며,
오직 문제 자체만 보고 처음부터 다시 풀어야 한다.

중요 규칙:
1. 먼저 문제의 분야와 문제 유형을 파악한다.
2. 주어진 숫자가 무엇의 개수인지 정확히 구분한다.
   예: 꼭짓점 수, 모서리 수, 면 수, 삼각형 수를 서로 혼동하지 않는다.
3. 공식에 변수를 대입하기 전에 각 변수의 의미가 문제의 조건과 일치하는지 확인한다.
4. 특정 전문 분야나 자격증 문제라면 해당 분야의 정의와 관계를 고려한다.
5. 겉보기에 계산 가능한 숫자라고 해서 임의의 공식을 적용하지 않는다.
6. 계산 후 다시 검산한다.
7. 확실하지 않으면 추측하지 말고 confident=false로 한다.
8. JSON 이외의 내용은 출력하지 않는다.
`
                },
             {
    role: "user",
    content: `
[문제]
${problem}

[1차 AI 후보 정답]


이 문제를 처음부터 독립적으로 다시 풀어라.

규칙:
- 후보 정답을 정답이라고 가정하지 않는다.
- 먼저 문제의 과목, 분야, 문제 유형을 파악한다.
- 해당 분야에서 필요한 정의, 공식, 법칙, 조건을 판단한다.
- 수학 문제뿐 아니라 고등학교 교과 문제와 자격증 전문 문제의 분야별 지식을 고려한다.
- 계산 문제는 직접 다시 계산하고 검산한다.
- 객관식이면 각 선택지와 계산 또는 추론 결과를 검토한다.
- 문제 정보가 부족하거나 정답을 충분히 확정할 수 없으면 confident를 false로 한다.

출력 규칙:
- 반드시 JSON 객체 하나만 출력한다.
- reviewAnswer에는 최종 정답만 넣는다.
- 숫자 정답이면 숫자만 넣는다.
- 객관식이면 최종 선택지만 넣는다.
- 단답형이면 필요한 최종 답만 짧게 넣는다.
- reviewAnswer에 풀이, 설명, 공식, 이유를 넣지 않는다.
- JSON 이외의 텍스트를 출력하지 않는다.

출력 구조:
{
    "reviewAnswer": "",
    "confident": false
}
`
}
            ],
           max_completion_tokens: 800
        })
    });

    const data = await response.json();
    console.log("REVIEW FINISH:", data?.choices?.[0]?.finish_reason);
console.log("REVIEW USAGE:", data?.usage);
console.log("REVIEW MESSAGE:", data?.choices?.[0]?.message);

    if (!response.ok) {
        throw new Error(JSON.stringify(data));
    }

    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error("정답 검산 AI의 응답이 없습니다.");
    }

    console.log("ANSWER REVIEW RAW:", content);

    let parsed;

    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error("정답 검산 AI의 JSON 형식이 올바르지 않습니다.");
    }

    return {
        reviewAnswer: safeText(parsed.reviewAnswer),
        confident: parsed.confident === true
    };
}

async function requestOpenAIAnalyze(problem, userAnswer, correctAnswer, plan, apiKey) { aiStats.total += 1;
    const maxTokens = plan === "free" ? 400 : plan === "premium5900" ? 600 : 800;

const answerResult = await requestOpenAIAnswer(problem, apiKey);

console.log("ANSWER 1 RESULT:", answerResult);

const firstAnswer = normalizeAnswer(answerResult.aiAnswer);
const checkAnswer = normalizeAnswer(answerResult.checkAnswer);
const enteredCorrectAnswer = normalizeAnswer(correctAnswer);

let verifiedAnswer = "";

// 1차 none으로 끝낼 수 있는 조건
const firstPassed =
    answerResult.confident &&
    firstAnswer &&
    checkAnswer &&
    enteredCorrectAnswer &&
    answersEquivalent(answerResult.aiAnswer, answerResult.checkAnswer, problem) &&
    answersEquivalent(answerResult.aiAnswer, correctAnswer, problem);

if (firstPassed) {
    // AI 1차 답 = AI 자체검산 답 = 사용자가 입력한 정답
    // 세 개가 모두 같으므로 medium 호출 생략
    verifiedAnswer = answerResult.aiAnswer;

    console.log(
        "ANSWER VERIFIED BY NONE:",
        verifiedAnswer
    );
} else {
    // 하나라도 다르면 2차 medium 검증
    aiStats.mediumUsed += 1;

    console.log("ANSWER NEEDS MEDIUM REVIEW:", {
        aiAnswer: answerResult.aiAnswer,
        checkAnswer: answerResult.checkAnswer,
        enteredCorrectAnswer: correctAnswer,
        confident: answerResult.confident
    });

    const reviewResult = await requestOpenAIAnswerReview(
        problem,
        apiKey
    );

    console.log(
        "ANSWER REVIEW RESULT:",
        reviewResult
    );

    const reviewedAnswer = normalizeAnswer(
        reviewResult.reviewAnswer
    );

    if (!reviewResult.confident || !reviewedAnswer) {
        throw new Error(
            "2차 medium AI도 문제의 정답을 확정하지 못했습니다."
        );
    }

// if (normalizeAnswer(answerResult.aiAnswer) !== reviewedAnswer) {
//     throw new Error(
//         `정답 검증 AI끼리 결과가 다릅니다. 1차: ${answerResult.aiAnswer}, 2차: ${reviewResult.reviewAnswer}`
//     );
// }

const normalizedFirst = normalizeAnswer(answerResult.aiAnswer);
const normalizedReview = reviewedAnswer;
const normalizedEntered = normalizeAnswer(correctAnswer);

if (
    answersEquivalent(
        reviewResult.reviewAnswer,
        correctAnswer,
        problem
    )
) {
    // 2차 검증 결과가 사용자가 입력한 정답과 같음
    // → 2차 결과를 최종 정답으로 사용
    verifiedAnswer = reviewResult.reviewAnswer;

    console.log(
        "ANSWER VERIFIED BY REVIEW + ENTERED:",
        verifiedAnswer
    );

} else if (
    answersEquivalent(
        reviewResult.reviewAnswer,
        answerResult.aiAnswer,
        problem
    )
) {
    // 1차와 2차 AI가 서로 같음
    // → AI 둘이 같은 답을 냈으므로 그 답을 채택
    // → 사용자가 입력한 정답이 잘못됐을 가능성이 있음
    verifiedAnswer = reviewResult.reviewAnswer;

    console.warn("ENTERED ANSWER MAY BE WRONG:", {
        enteredCorrectAnswer: correctAnswer,
        aiVerifiedAnswer: verifiedAnswer
    });

} else {
    // 1차 none / 입력 정답 / 2차 medium이 서로 다르더라도
    // medium이 확신한 답을 냈다면 medium 결과를 최종 정답으로 사용
    if (reviewResult.confident === true && reviewResult.reviewAnswer) {
        verifiedAnswer = reviewResult.reviewAnswer;

        console.warn("ANSWER CONFLICT - MEDIUM OVERRIDE:", {
            enteredCorrectAnswer: correctAnswer,
            firstAnswer: answerResult.aiAnswer,
            reviewAnswer: reviewResult.reviewAnswer,
            verifiedAnswer
        });
    } else {
        console.warn("ANSWER CONFLICT - UNCERTAIN:", {
            enteredCorrectAnswer: correctAnswer,
            firstAnswer: answerResult.aiAnswer,
            reviewAnswer: reviewResult.reviewAnswer
        });

        throw new Error(
            "정답 검증 결과가 서로 달라 정답을 안전하게 확정할 수 없습니다."
        );
    }
}

}   


console.log("AI COST STATS:", {
    total: aiStats.total,
    mediumUsed: aiStats.mediumUsed,
    noneOnly: aiStats.total - aiStats.mediumUsed,
    mediumRate:
        aiStats.total > 0
            ? ((aiStats.mediumUsed / aiStats.total) * 100).toFixed(1) + "%"
            : "0%"
});

// 검증된 정답과 학생 답이 같으면 오답 분석 AI 호출 생략
const normalizedUserAnswer = normalizeAnswer(userAnswer);
const normalizedVerifiedAnswer = normalizeAnswer(verifiedAnswer);

if (
    normalizedUserAnswer &&
    normalizedVerifiedAnswer &&
    normalizedUserAnswer === normalizedVerifiedAnswer
) {
    const answerCheck = compareAnswers(
    verifiedAnswer,
    correctAnswer,
    problem
);

    console.log("USER ANSWER ALREADY CORRECT - SKIP ANALYZE:", {
        userAnswer,
        verifiedAnswer
    });

    return {
        aiAnswer: verifiedAnswer,
        verification: answerCheck.verification,
        warning: answerCheck.warning,
        reason: "",
        concept: "",
        solution: "",
        similarProblems: []
    };
}

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "gpt-5.4-mini",
reasoning_effort:
    plan === "free"
        ? "none"
        : "medium",
messages: [
                {
                    role: "system",
content: `
너는 학생용 오답노트 선생님이다.
검증된 정답을 기준으로만 설명한다.
검증된 정답과 모순되는 계산이나 공식을 절대 작성하지 않는다.
설명을 작성한 뒤 계산 결과가 검증된 정답과 일치하는지 내부적으로 검산한다.
반드시 JSON만 출력한다.
`
                },
                {
                    role: "user",
                   content: buildAnalyzePrompt(problem, userAnswer, verifiedAnswer, plan)
                }
            ],
max_completion_tokens: 2500
        })
    });

    const data = await response.json();

    console.log("ANALYZE FINISH:", data?.choices?.[0]?.finish_reason);
console.log("ANALYZE USAGE:", data?.usage);
console.log("ANALYZE MESSAGE:", data?.choices?.[0]?.message);

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

console.log("AI parsed:", parsed);
console.log("SIMILAR ANSWERS:", {
    similarAnswer1: parsed.similarAnswer1,
    similarAnswer2: parsed.similarAnswer2,
    similarAnswer3: parsed.similarAnswer3
});
console.log("similarProblem1:", parsed.similarProblem1);
console.log("similarProblem2:", parsed.similarProblem2);
console.log("similarProblem3:", parsed.similarProblem3);

 const similarCount = getPlanRule(plan).similarCount;

let similarProblems = [
    ensureCorrectChoice(
        safeText(parsed.similarProblem1),
        safeText(parsed.similarAnswer1)
    ),

    ensureCorrectChoice(
        safeText(parsed.similarProblem2),
        safeText(parsed.similarAnswer2)
    ),

    ensureCorrectChoice(
        safeText(parsed.similarProblem3),
        safeText(parsed.similarAnswer3)
    )
]
    .filter(Boolean)
    .slice(0, similarCount);

if (similarProblems.length < similarCount) {
    similarProblems = [
        ...similarProblems,
        ...makeFallbackSimilarProblems(problem, similarCount)
    ].slice(0, similarCount);
}

const aiAnswer = verifiedAnswer;
const answerCheck = compareAnswers(
    verifiedAnswer,
    correctAnswer,
    problem
);

console.log(
    "SANITIZED REASON:",
    answersEquivalent(userAnswer, verifiedAnswer, problem)
        ? ""
        : sanitizeReason(userAnswer, verifiedAnswer)
);
return {
    aiAnswer,

    verification: answerCheck.verification,
    warning: answerCheck.warning,

reason: answersEquivalent(
    userAnswer,
    verifiedAnswer,
    problem
)
    ? ""
    : sanitizeReason(userAnswer, verifiedAnswer),
    concept:
        safeText(parsed.concept) ||
        "개념 설명이 없습니다.",

    solution:
        safeText(parsed.solution) ||
        "해결 방법이 없습니다.",

    similarProblems
};

}


async function requestOpenAIAdvanced(problem, apiKey) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          reasoning_effort: "low",
            messages: [
                {
                    role: "system",
                    content: "너는 학생용 응용문제 생성기다. 반드시 JSON만 출력한다."
                },
                {
                    role: "user",
                    content: buildAdvancedPrompt(problem)
                }
            ],
            // temperature: 0.7,
            max_completion_tokens: 1200,
        })
    });

const data = await response.json();

console.log("ADVANCED FINISH:", data?.choices?.[0]?.finish_reason);
console.log("ADVANCED USAGE:", data?.usage);
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
- 원본 문제를 직접 풀어 어떤 사고 과정이 필요한지 확인한다.

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

4. 원본보다 한 단계 더 생각해야 하지만,
새로운 핵심 개념을 알아야만 풀 수 있는 문제로 만들지 않는다.

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

10. 원본 문제보다 지나치게 어렵거나 길게 만들지 않는다.

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

function buildDashboard(user) {
    ensureUserShape(user);

    
    const wrongNotes = [...user.notes];
const solvedNotes = [...user.solvedNotes];
const trashNotes = [...user.trashNotes];
const planRule = getPlanRule(user.plan);
    

    const recommendedReviews = [...wrongNotes]
        .sort((a, b) => {
            if ((b.repeatWrongCount || 0) !== (a.repeatWrongCount || 0)) {
                return (b.repeatWrongCount || 0) - (a.repeatWrongCount || 0);
            }
            return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
        })
        .slice(0, 3)
        .map((note) => ({
            id: note.id,
            subject: note.subject,
            problem: note.problem,
            repeatWrongCount: note.repeatWrongCount || 1
        }));

        
    let weakestSubject = null;
    let maxWrong = -1;

    ["수학", "영어", "국어", "과학", "사회", "기계일반"].forEach((subject) => {
        const count = wrongNotes.filter((note) => note.subject === subject).length;
        if (count > maxWrong) {
            maxWrong = count;
            weakestSubject = subject;
        }
    });

    return {
        user: sanitizeUser(user),
        planRule,
        usageAi: user.usageAi,
        usageAdvanced: user.usageAdvanced,
        wrongNotes,
        solvedNotes,
        trashNotes,
        analysisCache: user.analysisCache,
        recommendedReviews,
        weakestSubject: maxWrong > 0 ? weakestSubject : null,

 advancedUsage: {
        used: user.usageAdvanced.count,
        limit: 5,
        remaining: Math.max(0, 5 - user.usageAdvanced.count)
    }
};
}

function requireAuth(req, res, next) {
    const db = readDb();
    const user = db.users.find((u) => u.id === req.session.userId);

    if (!user) {
        return res.status(401).json({ error: "로그인이 필요합니다." });
    }

    ensureUserShape(user);
    req.db = db;
    req.currentUser = user;
    next();
}

app.post("/api/auth/register", async (req, res) => {
    try {
        const { name, email, password } = req.body;

        const cleanName = safeText(name);
        const cleanEmail = normalizeEmail(email);
        const cleanPassword = safeText(password);

        if (!cleanName || !cleanEmail || !cleanPassword) {
            return res.status(400).json({ error: "이름, 이메일, 비밀번호를 모두 입력해주세요." });
        }

        if (cleanPassword.length < 4) {
            return res.status(400).json({ error: "비밀번호는 4자 이상이어야 합니다." });
        }

        const db = readDb();

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

        req.session.userId = newUser.id;

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

        const db = readDb();

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

        req.session.userId = user.id;

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

app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
        res.json({ message: "로그아웃되었습니다." });
    });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
    writeDb(req.db);
    return res.json({
        dashboard: buildDashboard(req.currentUser)
    });
});

app.post("/api/extract-problem-image", requireAuth, async (req, res) => {
    try {
        const { imageData } = req.body;

        if (!imageData || typeof imageData !== "string") {
            return res.status(400).json({
                error: "사진을 선택해주세요."
            });
        }

        const apiKey = process.env.OPENAI_API_KEY;

        if (!apiKey) {
            return res.status(500).json({
                error: "OpenAI API 키가 없습니다."
            });
        }

        const response = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`
                },

                body: JSON.stringify({
                    model: "gpt-5.4-mini",

                    messages: [
                        {
                            role: "user",
                            content: [
                             {
    type: "text",
    text:
`사진 속 학습 문제를 정확하게 읽어 문제 전체를 추출해라.

규칙:
- 문제 번호, 본문, 수식, 조건을 모두 포함한다.
- 객관식이면 선택지 ① ② ③ ④ ⑤를 반드시 모두 포함한다.
- 선택지는 생략하거나 요약하지 않는다.
- [4점] 같은 배점은 있어도 되고 없어도 된다.
- 풀이, 해설, 정답은 작성하지 않는다.
- 수학식의 지수, 분수, 루트, 각도, π, 괄호, 부호를 최대한 정확하게 유지한다.
- 사진에 문제가 하나라면 그 문제 전체만 반환한다.
- 설명 없이 JSON만 출력한다.

{
  "problem": ""
}`
},
{
    type: "image_url",
    image_url: {
        url: imageData
    }
}
                            ]
                        }
                    ],

                    max_completion_tokens: 800
                })
            }
        );

        const data = await response.json();

        console.log(
            "IMAGE FINISH:",
            data?.choices?.[0]?.finish_reason
        );
        console.log(
            "IMAGE USAGE:",
            data?.usage
        );
        console.log(
            "IMAGE MESSAGE:",
            data?.choices?.[0]?.message
        );

        if (!response.ok) {
            console.error("IMAGE ERROR:", data);

            return res.status(502).json({
                error: "사진을 읽지 못했습니다."
            });
        }

        const content =
            data?.choices?.[0]?.message?.content;

        if (!content) {
            return res.status(502).json({
                error: "사진에서 문제를 찾지 못했습니다."
            });
        }

        let parsed;

        try {
            parsed = JSON.parse(content);
        } catch {
            return res.status(502).json({
                error: "사진 분석 결과를 읽지 못했습니다."
            });
        }

        const problem = safeText(parsed.problem);

        if (!problem) {
            return res.status(422).json({
                error: "사진에서 문제를 찾지 못했습니다."
            });
        }

        return res.json({
            problem
        });

    } catch (error) {
        console.error("IMAGE EXTRACT ERROR:", error);

        return res.status(500).json({
            error: "사진 처리 중 서버 오류가 발생했습니다."
        });
    }
});

app.post("/api/plan/test-change", requireAuth, (req, res) => {
    const { plan } = req.body;

    if (!PLAN_RULES[plan]) {
        return res.status(400).json({ error: "잘못된 요금제입니다." });
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

app.post("/api/analyze", requireAuth, async (req, res) => {

    console.log("🔥 /api/analyze 요청 들어옴");
console.log("body:", req.body);
console.log("user:", req.session?.user?.email || req.user?.email || "유저정보 없음");
    try {

       const {
    subject,
    problem,
    userAnswer,
    correctAnswer,
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

        console.log("sourceType:", cleanSourceType);


        if (!cleanSubject || !cleanProblem || !cleanUserAnswer || !cleanCorrectAnswer) {
            return res.status(400).json({ error: "과목, 문제, 내 답, 정답을 모두 입력해주세요." });
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

        const rule = getPlanRule(user.plan);

        // if (user.usageAi.count >= rule.aiDaily) {
        //     return res.status(403).json({ error: "오늘 AI 분석 횟수를 모두 사용했습니다." });
        // }
    

        const key = analysisKey(cleanSubject, cleanProblem, cleanUserAnswer, cleanCorrectAnswer, user.plan);

        const isInTrash = user.trashNotes.some(
    (note) =>
        note.subject === cleanSubject &&
        note.problem === cleanProblem &&
        answersEquivalent(
            note.correctAnswer,
            cleanCorrectAnswer,
            cleanProblem
        )
);

if (user.analysisCache[key] && !isInTrash) {
    return res.json({
        message: "이미 분석한 입력입니다. 저장된 결과를 다시 보여줍니다. 차감되지 않았습니다.",
        analysis: user.analysisCache[key],
        cached: true,
        dashboard: buildDashboard(user)
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

        if (!apiKey) {
            analysis = {
                ...makeFallbackAnalysis(cleanProblem, cleanUserAnswer, cleanCorrectAnswer, user.plan),
                advancedProblem: "아직 응용문제가 없습니다."
            };
      } else {
    try {
        const result = await requestOpenAIAnalyze(
            cleanProblem,
            cleanUserAnswer,
            cleanCorrectAnswer,
            user.plan,
            apiKey
        );

        analysis = {
            ...result,
            advancedProblem: "아직 응용문제가 없습니다."
        };

    } catch (error) {
        console.error("AI fallback:", error.message);

  // 문제 자체의 정보가 부족하거나 AI가 정답을 확정할 수 없는 경우
if (
    error.message.includes(
        "2차 medium AI도 문제의 정답을 확정하지 못했습니다"
    )
) {
    return res.status(409).json({
        error:
            "문제의 조건이나 정보가 부족하여 정답을 확정할 수 없습니다. 문제와 정답을 다시 확인해주세요.",
        verification: "uncertain",
        reason: "insufficient_information"
    });
}

// 1차와 2차 검증 결과가 서로 충돌하는 경우
if (
    error.message.includes(
        "정답 검증 결과가 서로 달라"
    )
) {
    return res.status(409).json({
        error:
            "AI 정답 검증 결과가 서로 달라 정답을 안전하게 확정할 수 없습니다. 문제와 입력한 정답을 다시 확인해주세요.",
        verification: "uncertain",
        reason: "answer_conflict"
    });
}

        analysis = {
            ...makeFallbackAnalysis(
                cleanProblem,
                cleanUserAnswer,
                cleanCorrectAnswer,
                user.plan
            ),
            advancedProblem: "아직 응용문제가 없습니다."
        };
    }
}

        user.usageAi.count += 1;
        user.analysisCache[key] = analysis;

const identity = noteKey(
    cleanSubject,
    cleanProblem,
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
                note.problem,
                note.correctAnswer
            ) === identity
    );

    let solvedNote = {
        id: randomUUID(),
        subject: cleanSubject,
        problem: cleanProblem,
        userAnswer: cleanUserAnswer,
        correctAnswer: cleanCorrectAnswer,
        reason: analysis.reason || "",
        concept: analysis.concept || "",
        solution: analysis.solution || "",
        similarProblems: analysis.similarProblems || [],
        advancedProblem: analysis.advancedProblem || "",
        sourceType: cleanSourceType,
        repeatWrongCount: 1,
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
            updatedAt: now(),
            solvedAt: now()
        };

        user.notes.splice(wrongIndex, 1);
    }

    const solvedExists = user.solvedNotes.some(
        (note) =>
            noteKey(
                note.subject,
                note.problem,
                note.correctAnswer
            ) === identity
    );

    if (!solvedExists) {
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
                note.problem,
                note.correctAnswer
            ) === identity
    );

    if (existingIndex === -1) {
        if (
            rule.storageLimit !== Infinity &&
            user.notes.length >= rule.storageLimit
        ) {
            return res.status(403).json({
                error: `현재 요금제 저장 한도(${rule.storageLimit}개)를 넘었습니다. 오래된 오답을 지우거나 상위 요금제로 바꿔야 합니다.`
            });
        }

        user.notes.push({
            id: randomUUID(),
            subject: cleanSubject,
            problem: cleanProblem,
            userAnswer: cleanUserAnswer,
            correctAnswer: cleanCorrectAnswer,
            reason: analysis.reason,
            concept: analysis.concept,
            solution: analysis.solution,
            similarProblems: analysis.similarProblems || [],
            advancedProblem: analysis.advancedProblem || "",
            sourceType: cleanSourceType,
            repeatWrongCount: 1,
            createdAt: now(),
            updatedAt: now()
        });

    } else {
        user.notes[existingIndex] = {
            ...user.notes[existingIndex],
            userAnswer: cleanUserAnswer,
            reason: analysis.reason,
            concept: analysis.concept,
            solution: analysis.solution,
            similarProblems: analysis.similarProblems || [],
            advancedProblem: analysis.advancedProblem || "",
            sourceType: cleanSourceType,
            updatedAt: now(),
            repeatWrongCount:
                (user.notes[existingIndex].repeatWrongCount || 1) + 1
        };
    }
}

        writeDb(req.db);

        return res.json({
            message: "AI 분석을 저장했습니다.",
            analysis,
            cached: false,
            dashboard: buildDashboard(user)
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "분석 중 서버 오류가 발생했습니다." });
    }
});

app.post("/api/advanced-problem", requireAuth, async (req, res) => {
    try {
        const { subject, problem } = req.body;
        const user = req.currentUser;
        ensureUserShape(user);

        const cleanSubject = safeText(subject);
        const cleanProblem = safeText(problem);

        if (!cleanProblem) {
            return res.status(400).json({ error: "문제를 입력해주세요." });
        }

        const rule = getPlanRule(user.plan);

        if (!rule.advancedEnabled) {
            return res.status(403).json({ error: "응용문제는 8900원 요금제에서만 사용할 수 있습니다." });
        }

        const key = advancedProblemKey(cleanSubject, cleanProblem);

        // if (user.usageAdvanced.count >= 5) {
        //     return res.status(403).json({ error: "오늘 응용문제 생성 5회를 모두 사용했습니다." });
        // }

        if (user.usageAdvanced.usedKeys.includes(key)) {
            return res.status(403).json({ error: "이 문제는 이미 응용문제를 생성했습니다." });
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
        const result = await requestOpenAIAdvanced(cleanProblem, apiKey);

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

app.post("/api/notes/check", requireAuth, (req, res) => {
    try {
        const {
            subject,
            problem,
            userAnswer,
            correctAnswer,
            currentAnalysis,
            sourceType = "normal"
        } = req.body;

        const user = req.currentUser;
        ensureUserShape(user);

        const cleanSubject = safeText(subject);
        const cleanProblem = safeText(problem);
        const cleanUserAnswer = safeText(userAnswer);
        const cleanCorrectAnswer = safeText(correctAnswer);

        if (!cleanSubject || !cleanProblem || !cleanUserAnswer || !cleanCorrectAnswer) {
            return res.status(400).json({ error: "과목, 문제, 내 답, 정답을 모두 입력해주세요." });
        }

        const mathCheck = validateSimpleMathConsistency(cleanProblem, cleanCorrectAnswer);
        if (mathCheck.detectable && !mathCheck.isValid) {
            return res.status(400).json({
                error: `입력한 정답이 문제와 맞지 않을 수 있습니다. 이 문제의 계산상 정답은 ${mathCheck.expected} 입니다.`
            });
        }

        const identity = noteKey(cleanSubject, cleanProblem, cleanCorrectAnswer);

        if (
    answersEquivalent(
        cleanUserAnswer,
        cleanCorrectAnswer,
        cleanProblem
    )
) {
            const wrongIndex = user.notes.findIndex((note) => noteKey(note.subject, note.problem, note.correctAnswer) === identity);

            let baseNote = {
                id: randomUUID(),
                subject: cleanSubject,
                problem: cleanProblem,
                userAnswer: cleanUserAnswer,
                correctAnswer: cleanCorrectAnswer,
                reason: currentAnalysis?.reason || "",
                concept: currentAnalysis?.concept || "",
                solution: currentAnalysis?.solution || "",
                similarProblems: Array.isArray(currentAnalysis?.similarProblems) ? currentAnalysis.similarProblems : [],
                advancedProblem: currentAnalysis?.advancedProblem || "",
                sourceType,
                repeatWrongCount: 1,
                createdAt: now(),
                updatedAt: now()
            };

            if (wrongIndex !== -1) {
                baseNote = user.notes[wrongIndex];
                user.notes.splice(wrongIndex, 1);
            }

            const solvedExists = user.solvedNotes.some((note) => noteKey(note.subject, note.problem, note.correctAnswer) === identity);

            if (!solvedExists) {
                user.solvedNotes.push({
                    ...baseNote,
                    userAnswer: cleanUserAnswer,
                    solvedAt: now()
                });
            }

            writeDb(req.db);

            return res.json({
                message: sourceType === "normal"
                    ? "정답입니다. 복습완료로 이동했습니다."
                    : "추가 문제를 맞혔습니다. 복습완료로 이동했습니다.",
               clearInputs: sourceType !== "similar",
                dashboard: buildDashboard(user)
            });
        }

        const existingIndex = user.notes.findIndex((note) => noteKey(note.subject, note.problem, note.correctAnswer) === identity);
        const rule = getPlanRule(user.plan);

        if (existingIndex === -1 && rule.storageLimit !== Infinity && user.notes.length >= rule.storageLimit) {
            return res.status(403).json({
                error: `현재 요금제 저장 한도(${rule.storageLimit}개)를 넘었습니다. 오래된 오답을 지우거나 상위 요금제로 바꿔야 합니다.`
            });
        }

        const updatedNote = {
            id: existingIndex !== -1 ? user.notes[existingIndex].id : randomUUID(),
            subject: cleanSubject,
            problem: cleanProblem,
            userAnswer: cleanUserAnswer,
            correctAnswer: cleanCorrectAnswer,
            reason: currentAnalysis?.reason || "정답과 다른 답입니다.",
            concept: currentAnalysis?.concept || "핵심 개념을 다시 확인해야 합니다.",
            solution: currentAnalysis?.solution || "풀이 순서를 짧게 적고 다시 풀어보세요.",
            similarProblems: Array.isArray(currentAnalysis?.similarProblems) ? currentAnalysis.similarProblems : [],
            advancedProblem: currentAnalysis?.advancedProblem || "",
            sourceType,
            repeatWrongCount: existingIndex !== -1 ? (user.notes[existingIndex].repeatWrongCount || 1) + 1 : 1,
            createdAt: existingIndex !== -1 ? user.notes[existingIndex].createdAt : now(),
            updatedAt: now()
        };

        if (existingIndex !== -1) {
            user.notes[existingIndex] = updatedNote;
        } else {
            user.notes.push(updatedNote);
        }

        writeDb(req.db);

        return res.json({
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

    if (trashFrom === "wrong") {
        const exists = user.notes.some(
            (item) =>
                noteKey(
                    item.subject,
                    item.problem,
                    item.correctAnswer
                ) ===
                noteKey(
                    restoredNote.subject,
                    restoredNote.problem,
                    restoredNote.correctAnswer
                )
        );

        const rule = getPlanRule(user.plan);

        if (
            !exists &&
            rule.storageLimit !== Infinity &&
            user.notes.length >= rule.storageLimit
        ) {
            return res.status(403).json({
                error: `현재 요금제 저장 한도(${rule.storageLimit}개)를 넘었습니다.`
            });
        }

        if (!exists) {
            user.notes.push(restoredNote);
        }

    } else if (trashFrom === "solved") {

        const exists = user.solvedNotes.some(
            (item) =>
                noteKey(
                    item.subject,
                    item.problem,
                    item.correctAnswer
                ) ===
                noteKey(
                    restoredNote.subject,
                    restoredNote.problem,
                    restoredNote.correctAnswer
                )
        );

        if (!exists) {
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

app.post("/api/trash/delete", requireAuth, (req, res) => {
    const { id } = req.body;
    const user = req.currentUser;

    ensureUserShape(user);

    const note =
        user.trashNotes.find((item) => item.id === id);

    if (!note) {
        return res.status(404).json({
            error: "영구삭제할 문제를 찾을 수 없습니다."
        });
    }

    permanentlyCleanupNote(user, note);

    user.trashNotes =
        user.trashNotes.filter((item) => item.id !== id);

    writeDb(req.db);

    return res.json({
        message: "문제를 영구삭제했습니다.",
        dashboard: buildDashboard(user)
    });
});

app.post("/api/trash/clear", requireAuth, (req, res) => {
    const user = req.currentUser;

    ensureUserShape(user);

    user.trashNotes.forEach((note) => {
        permanentlyCleanupNote(user, note);
    });

    user.trashNotes = [];

    writeDb(req.db);

    return res.json({
        message: "휴지통을 비웠습니다.",
        dashboard: buildDashboard(user)
    });
});

app.post("/api/solved/restore", requireAuth, (req, res) => {
    const { id } = req.body;
    const user = req.currentUser;
    ensureUserShape(user);

    const note = user.solvedNotes.find((item) => item.id === id);
    if (!note) {
        return res.status(404).json({ error: "복습완료 문제를 찾을 수 없습니다." });
    }

    const exists = user.notes.some((item) => noteKey(item.subject, item.problem, item.correctAnswer) === noteKey(note.subject, note.problem, note.correctAnswer));
    const rule = getPlanRule(user.plan);

    if (!exists && rule.storageLimit !== Infinity && user.notes.length >= rule.storageLimit) {
        return res.status(403).json({ error: `현재 요금제 저장 한도(${rule.storageLimit}개)를 넘었습니다.` });
    }

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

app.get("*", (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://0.0.0.0:${PORT}`);
});