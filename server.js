
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
app.use(express.json({ limit: "1mb" }));
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
    if (!user.analysisCache || typeof user.analysisCache !== "object") user.analysisCache = {};
    if (!user.advancedAnswerMap) user.advancedAnswerMap = {};

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

function buildAnalyzePrompt(problem, userAnswer, correctAnswer, plan) {
    const similarCount = getPlanRule(plan).similarCount;

    const planGuide =
        plan === "free"
            ? "reason, concept, solution은 각각 한국어 1문장, 50자 이내."
            : plan === "premium5900"
            ? "reason, concept, solution은 각각 한국어 1~2문장, 짧고 분명하게."
            : "reason, concept, solution은 각각 한국어 1~2문장으로 정확하게.";

    return `
문제: ${problem}
학생의 답: ${userAnswer}
사용자가 입력한 정답: ${correctAnswer}

먼저 문제를 직접 풀어서 실제 정답을 판단해라.
사용자가 입력한 정답을 무조건 믿지 마라.

검증 규칙:
- AI가 판단한 정답과 사용자가 입력한 정답이 같으면 verification은 "match"
- 서로 다르면 verification은 "mismatch"
- 문제 정보가 부족하거나 복수 정답 가능성이 있으면 verification은 "uncertain"
- mismatch이면 warning에 "입력한 정답이 실제 정답과 다를 수 있습니다. 정답을 다시 확인해 주세요." 작성
- match이면 warning은 빈 문자열
- uncertain이면 warning에 "문제 정보가 부족하거나 정답을 확정하기 어렵습니다." 작성
- aiAnswer에는 AI가 판단한 최종 정답만 짧게 작성
- 긴 사고 과정은 출력하지 말 것

학생의 오답을 분석해라.
${planGuide}

반드시 아래 JSON 형식만 출력해라.
{
  "aiAnswer": "",
  "verification": "match",
  "warning": "",
  "reason": "",
  "concept": "",
  "solution": "",
  "similarProblems": []
}

공통 규칙:
- JSON 이외의 글은 출력하지 말 것
- aiAnswer는 최종 정답만 작성
- reason, concept, solution은 서로 다른 내용으로 작성
- similarProblems는 정확히 ${similarCount}개 작성
- 유사문제에는 정답이나 해설을 넣지 말 것
`;
}

async function requestOpenAIAnalyze(problem, userAnswer, correctAnswer, plan, apiKey) {
    const maxTokens = plan === "free" ? 220 : plan === "premium5900" ? 320 : 420;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "너는 학생용 오답노트 선생님이다. 반드시 JSON만 출력하고 짧고 정확하게 설명한다."
                },
                {
                    role: "user",
                    content: buildAnalyzePrompt(problem, userAnswer, correctAnswer, plan)
                }
            ],
           temperature: plan === "free" ? 0.4 : plan === "premium5900" ? 0.55 : 0.65,
            max_tokens: maxTokens
        })
    });

    const data = await response.json();

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
console.log("similarProblems:", parsed.similarProblems);

    const similarCount = getPlanRule(plan).similarCount;
    let similarProblems = Array.isArray(parsed.similarProblems) ? parsed.similarProblems : [];
   similarProblems = similarProblems
    .map((v) => {
        if (typeof v === "string") return safeText(v);

        if (v && typeof v === "object") {
            return safeText(
                v.problem ||
                v.question ||
                v.text ||
                v.content ||
                v.prompt
            );
        }

        return "";
    })
    .filter(Boolean);

    if (similarProblems.length < similarCount) {
        similarProblems = [...similarProblems, ...makeFallbackSimilarProblems(problem, similarCount)].slice(0, similarCount);
    }
return {
    aiAnswer: safeText(parsed.aiAnswer) || "",
    verification: ["match", "mismatch", "uncertain"].includes(
        parsed.verification
    )
        ? parsed.verification
        : "uncertain",
    warning: safeText(parsed.warning) || "",

    reason:
        safeText(parsed.reason) ||
        "분석 결과가 없습니다.",

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
            model: "gpt-4o-mini",
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
            temperature: 0.7,
            max_tokens: 220
        })
    });

    const data = await response.json();

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
다음 문제를 바탕으로 같은 개념의 응용문제를 하나 만들어라.

원본 문제:
${problem}

반드시 JSON만 출력한다.

{
  "advancedProblem": "응용문제",
  "answer": "정답"
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
        
        if (cleanSourceType === "advanced") {
    const expectedAdvancedAnswer =
        safeText(user.advancedAnswerMap?.[cleanProblem]);

    if (
        expectedAdvancedAnswer &&
        cleanCorrectAnswer !== expectedAdvancedAnswer
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

if (cleanUserAnswer === cleanCorrectAnswer) {
    return res.status(400).json({
        error: "정답인 상태에서는 AI 분석을 하지 않습니다."
    });
}

        const rule = getPlanRule(user.plan);

        // if (user.usageAi.count >= rule.aiDaily) {
        //     return res.status(403).json({ error: "오늘 AI 분석 횟수를 모두 사용했습니다." });
        // }
    

        const key = analysisKey(cleanSubject, cleanProblem, cleanUserAnswer, cleanCorrectAnswer, user.plan);

        if (user.analysisCache[key]) {
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
                const result = await requestOpenAIAnalyze(cleanProblem, cleanUserAnswer, cleanCorrectAnswer, user.plan, apiKey);
                analysis = {
                    ...result,
                    advancedProblem: "아직 응용문제가 없습니다."
                };
            } catch (error) {
                console.error("AI fallback:", error.message);
                analysis = {
                    ...makeFallbackAnalysis(cleanProblem, cleanUserAnswer, cleanCorrectAnswer, user.plan),
                    advancedProblem: "아직 응용문제가 없습니다."
                };
            }
        }

        user.usageAi.count += 1;
        user.analysisCache[key] = analysis;

        const identity = noteKey(cleanSubject, cleanProblem, cleanCorrectAnswer);
        const existingIndex = user.notes.findIndex((note) => noteKey(note.subject, note.problem, note.correctAnswer) === identity);

        if (existingIndex === -1) {
            if (rule.storageLimit !== Infinity && user.notes.length >= rule.storageLimit) {
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
                repeatWrongCount: (user.notes[existingIndex].repeatWrongCount || 1) + 1
            };
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

if (advancedProblem && advancedAnswer) {
    user.advancedAnswerMap[advancedProblem] = advancedAnswer;
}

console.log("advancedAnswerMap =", user.advancedAnswerMap);


        user.usageAdvanced.count += 1;
        user.usageAdvanced.usedKeys.push(key);

        writeDb(req.db);

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

        if (cleanUserAnswer === cleanCorrectAnswer) {
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
                clearInputs: true,
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

    const deletedNote = user.notes.find((note) => note.id === id);

    if (!deletedNote) {
        return res.status(404).json({
            error: "삭제할 오답을 찾을 수 없습니다."
        });
    }

    // 삭제한 문제와 관련된 분석 캐시도 같이 삭제
    const cachePrefix =
        `${user.plan}::${deletedNote.subject}::${deletedNote.problem}::`;

    Object.keys(user.analysisCache).forEach((key) => {
        if (key.startsWith(cachePrefix)) {
            delete user.analysisCache[key];
        }
    });

    // 응용문제 생성 기록 삭제
const advancedKey =
    advancedProblemKey(deletedNote.subject, deletedNote.problem);

user.usageAdvanced.usedKeys =
    user.usageAdvanced.usedKeys.filter((key) => key !== advancedKey);

// 생성했던 응용문제의 정답 기록 정리
if (deletedNote.advancedProblem) {
    delete user.advancedAnswerMap[deletedNote.advancedProblem];
}

    // 오답 삭제
    user.notes = user.notes.filter((note) => note.id !== id);

    writeDb(req.db);

    return res.json({
        message: "오답을 삭제했습니다.",
        dashboard: buildDashboard(user)
    });
});

app.post("/api/notes/clear", requireAuth, (req, res) => {
    req.currentUser.notes = [];
    writeDb(req.db);

    return res.json({
        message: "오답 리스트를 전체 삭제했습니다.",
        dashboard: buildDashboard(req.currentUser)
    });
});

app.post("/api/solved/delete", requireAuth, (req, res) => {
    const { id } = req.body;
    req.currentUser.solvedNotes = req.currentUser.solvedNotes.filter((note) => note.id !== id);
    writeDb(req.db);

    return res.json({
        message: "복습완료 문제를 삭제했습니다.",
        dashboard: buildDashboard(req.currentUser)
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