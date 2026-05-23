let dashboardState = null;
let currentAnalysisState = null;
let activeModeState = null;

function $(id) {
    return document.getElementById(id);
}

function escapeHtml(text) {
    return String(text || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function showAuthMessage(text, color = "blue") {
    $("authMessage").textContent = text;
    $("authMessage").style.color = color;
}

function showMessage(text, color = "blue") {
    $("messageText").textContent = text;
    $("messageText").style.color = color;
}

function setLoading(isLoading) {
    $("analyzeBtn").disabled = isLoading;
    $("checkBtn").disabled = isLoading;
    $("loadingSpinner").style.display = isLoading ? "inline-block" : "none";
}

function getPlanLabel(plan) {
    if (plan === "premium5900") return "5900원";
    if (plan === "premium8900") return "8900원";
    return "무료";
}

function getCurrentPlanRule() {
    return dashboardState?.planRule || {
        aiDaily: 2,
        storageLimit: 50,
        similarCount: 1,
        reviewEnabled: false,
        duplicateAnalyze: false,
        advancedEnabled: false
    };
}

function updateModeUI() {
    const isSimilar = activeModeState?.type === "similar";
    const isAdvanced = activeModeState?.type === "advanced";
    const hasMode = isSimilar || isAdvanced;

    $("similarModeText").hidden = !isSimilar;
    $("advancedModeText").hidden = !isAdvanced;
    $("exitModeBtn").hidden = !hasMode;
}

function clearActiveMode() {
    activeModeState = null;
    updateModeUI();
}

function clearInputs() {
    $("problem").value = "";
    $("userAnswer").value = "";
    $("correctAnswer").value = "";
    currentAnalysisState = null;
    clearActiveMode();
    renderCurrentAnalysis();
}

function applyPlanToCurrentAnalysis() {
    if (!dashboardState || !currentAnalysisState) return;

    const rule = getCurrentPlanRule();

    if (Array.isArray(currentAnalysisState.similarProblems)) {
        currentAnalysisState.similarProblems = currentAnalysisState.similarProblems.slice(0, rule.similarCount);
    }

    if (!rule.advancedEnabled) {
        currentAnalysisState.advancedProblem = "아직 응용문제가 없습니다.";
        if (activeModeState?.type === "advanced") {
            activeModeState = null;
        }
    }

    renderCurrentAnalysis();
    updateModeUI();
}

function renderCurrentAnalysis() {
    const state = currentAnalysisState || {};

    $("resultReason").textContent = state.reason || "아직 분석 결과가 없습니다.";
    $("resultConcept").textContent = state.concept || "아직 분석 결과가 없습니다.";
    $("resultSolution").textContent = state.solution || "아직 분석 결과가 없습니다.";
    $("advancedProblemBox").textContent = state.advancedProblem || "아직 응용문제가 없습니다.";

    renderSimilarProblems(state.similarProblems || []);
    updateUpsellTexts(state.similarProblems || []);
}

function updateUpsellTexts(similarProblems) {
    if (!dashboardState) return;

    const plan = dashboardState.user.plan;

    if (plan === "free") {
        $("analysisUpsellText").textContent = "유료 플랜에서는 유사문제 개수와 복습 기능이 더 늘어납니다.";
        $("similarUpsellText").textContent = similarProblems.length >= 1 ? "5900원부터 유사문제가 더 늘어납니다." : "";
    } else if (plan === "premium5900") {
        $("analysisUpsellText").textContent = "";
        $("similarUpsellText").textContent = "8900원에서는 응용문제와 약한 과목 분석이 추가됩니다.";
    } else {
        $("analysisUpsellText").textContent = "";
        $("similarUpsellText").textContent = "";
    }
}

function renderSimilarProblems(items) {
    const box = $("similarProblemsBox");
    box.innerHTML = "";

    if (!items || items.length === 0) {
        box.innerHTML = `<div class="problem-item"><div class="problem-item-text">아직 유사문제가 없습니다.</div></div>`;
        return;
    }

    items.forEach((problem, index) => {
        const div = document.createElement("div");
        div.className = "problem-item";
        div.innerHTML = `
            <div class="problem-item-title">유사문제 ${index + 1}</div>
            <div class="problem-item-text">${escapeHtml(problem)}</div>
            <div class="button-row">
                <button type="button" class="secondary-btn" data-index="${index}">이 문제 풀기</button>
            </div>
        `;
        box.appendChild(div);
    });

    box.querySelectorAll("[data-index]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const idx = Number(btn.dataset.index);
            const chosen = currentAnalysisState?.similarProblems?.[idx];
            if (!chosen) return;

            $("problem").value = chosen;
            $("userAnswer").value = "";
            $("correctAnswer").value = "";
            activeModeState = { type: "similar", sourceIndex: idx };
            updateModeUI();
            showMessage("유사문제를 불러왔습니다. 정답을 직접 입력하고 채점하세요.", "blue");
            $("problem").focus();
        });
    });
}

function updatePlanLocks() {
    if (!dashboardState) return;

    const rule = dashboardState.planRule;

    $("cardRecommend").hidden = !rule.reviewEnabled;
    $("cardSummary").hidden = !rule.reviewEnabled;
    $("cardSubjectStats").hidden = !rule.reviewEnabled;
    $("cardSolved").hidden = !rule.reviewEnabled;
    $("cardAdvanced").hidden = !rule.advancedEnabled;
}

function getFilteredAndSortedWrongNotes() {
    if (!dashboardState) return [];

    let notes = [...(dashboardState.wrongNotes || [])];
    const filterSubject = $("filterSubject").value;
    const search = $("searchInput").value.trim().toLowerCase();
    const sortType = $("sortType").value;

    if (filterSubject !== "전체") {
        notes = notes.filter((note) => note.subject === filterSubject);
    }

    if (search) {
        notes = notes.filter((note) =>
            note.problem.toLowerCase().includes(search) ||
            note.userAnswer.toLowerCase().includes(search) ||
            note.correctAnswer.toLowerCase().includes(search) ||
            String(note.reason || "").toLowerCase().includes(search) ||
            String(note.concept || "").toLowerCase().includes(search) ||
            String(note.solution || "").toLowerCase().includes(search)
        );
    }

    if (sortType === "latest") {
        notes.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    } else if (sortType === "oldest") {
        notes.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    } else if (sortType === "subject") {
        notes.sort((a, b) => a.subject.localeCompare(b.subject));
    } else if (sortType === "repeat") {
        notes.sort((a, b) => (b.repeatWrongCount || 0) - (a.repeatWrongCount || 0));
    }

    return notes;
}

function renderWrongList() {
    const list = $("wrongList");
    const notes = getFilteredAndSortedWrongNotes();

    list.innerHTML = "";

    if (notes.length === 0) {
        list.innerHTML = "<li>조건에 맞는 오답이 없습니다.</li>";
        return;
    }

    notes.forEach((note) => {
        const typeLabel =
            note.sourceType === "similar"
                ? "유사문제"
                : note.sourceType === "advanced"
                ? "응용문제"
                : "기본 문제";

        const li = document.createElement("li");
        li.innerHTML = `
            <div><strong>구분:</strong> ${escapeHtml(typeLabel)}</div>
            <div><strong>과목:</strong> ${escapeHtml(note.subject)}</div>
            <div><strong>문제:</strong> ${escapeHtml(note.problem)}</div>
            <div><strong>내 답:</strong> ${escapeHtml(note.userAnswer)}</div>
            <div><strong>정답:</strong> ${escapeHtml(note.correctAnswer)}</div>
            <div><strong>틀린 이유:</strong> ${escapeHtml(note.reason || "-")}</div>
            <div><strong>부족한 개념:</strong> ${escapeHtml(note.concept || "-")}</div>
            <div><strong>해결 방법:</strong> ${escapeHtml(note.solution || "-")}</div>
            <div><strong>반복 횟수:</strong> ${note.repeatWrongCount || 1}</div>
            <div class="item-buttons">
                <button type="button" data-retry="${note.id}">다시풀기</button>
                <button type="button" class="delete-item-btn" data-delete="${note.id}">삭제</button>
            </div>
        `;
        list.appendChild(li);
    });

    list.querySelectorAll("[data-retry]").forEach((btn) => {
        btn.addEventListener("click", () => retryWrongNote(btn.dataset.retry));
    });

    list.querySelectorAll("[data-delete]").forEach((btn) => {
        btn.addEventListener("click", () => deleteWrongNote(btn.dataset.delete));
    });
}

function renderSolvedList() {
    const list = $("solvedList");
    const notes = [...(dashboardState?.solvedNotes || [])].sort((a, b) => (b.solvedAt || 0) - (a.solvedAt || 0));

    list.innerHTML = "";

    if (notes.length === 0) {
        list.innerHTML = "<li>복습 완료된 문제가 없습니다.</li>";
        return;
    }

    notes.forEach((note) => {
        const typeLabel =
            note.sourceType === "similar"
                ? "유사문제"
                : note.sourceType === "advanced"
                ? "응용문제"
                : "기본 문제";

        const li = document.createElement("li");
        li.innerHTML = `
            <div><strong>구분:</strong> ${escapeHtml(typeLabel)}</div>
            <div><strong>과목:</strong> ${escapeHtml(note.subject)}</div>
            <div><strong>문제:</strong> ${escapeHtml(note.problem)}</div>
            <div><strong>내 답:</strong> ${escapeHtml(note.userAnswer)}</div>
            <div><strong>정답:</strong> ${escapeHtml(note.correctAnswer)}</div>
            <div class="item-buttons">
                <button type="button" data-restore="${note.id}">오답으로 복원</button>
                <button type="button" class="delete-item-btn" data-delete-solved="${note.id}">삭제</button>
            </div>
        `;
        list.appendChild(li);
    });

    list.querySelectorAll("[data-restore]").forEach((btn) => {
        btn.addEventListener("click", () => restoreSolvedNote(btn.dataset.restore));
    });

    list.querySelectorAll("[data-delete-solved]").forEach((btn) => {
        btn.addEventListener("click", () => deleteSolvedNote(btn.dataset.deleteSolved));
    });
}

function renderRecommendedReviews() {
    const box = $("recommendedReviewBox");
    const list = dashboardState?.recommendedReviews || [];

    box.innerHTML = "";

    if (list.length === 0) {
        box.innerHTML = `<div class="problem-item"><div class="problem-item-text">추천 복습 문제가 아직 없습니다.</div></div>`;
        return;
    }

    list.forEach((item) => {
        const div = document.createElement("div");
        div.className = "problem-item";
        div.innerHTML = `
            <div class="problem-item-title">${escapeHtml(item.subject)} / 반복오답 ${item.repeatWrongCount}회</div>
            <div class="problem-item-text">${escapeHtml(item.problem)}</div>
        `;
        box.appendChild(div);
    });
}

function renderSummaryStats() {
    const wrongNotes = dashboardState?.wrongNotes || [];
    const solvedNotes = dashboardState?.solvedNotes || [];

    const totalWrong = wrongNotes.length;
    const totalSolved = solvedNotes.length;
    const totalHandled = totalWrong + totalSolved;

    const extraSolved = solvedNotes.filter((note) => note.sourceType === "similar" || note.sourceType === "advanced").length;
    const extraWrong = wrongNotes.filter((note) => note.sourceType === "similar" || note.sourceType === "advanced").length;
    const totalExtra = extraSolved + extraWrong;

    const accuracy = totalHandled === 0 ? 0 : Math.round((totalSolved / totalHandled) * 100);
    const extraAccuracy = totalExtra === 0 ? 0 : Math.round((extraSolved / totalExtra) * 100);

    $("summaryWrongCount").textContent = String(totalWrong);
    $("summarySolvedCount").textContent = String(totalSolved);
    $("summaryAccuracy").textContent = `${accuracy}%`;
    $("summaryExtraAccuracy").textContent = `${extraAccuracy}%`;
}

function renderSubjectStats() {
    const box = $("subjectStats");
    const weaknessBox = $("weaknessBadgeBox");
    const wrongNotes = dashboardState?.wrongNotes || [];
    const solvedNotes = dashboardState?.solvedNotes || [];
    const plan = dashboardState?.user?.plan;

    box.innerHTML = "";

    ["수학", "영어", "국어", "과학", "사회", "기계일반"].forEach((subject) => {
        const wrongCount = wrongNotes.filter((note) => note.subject === subject).length;
        const solvedCount = solvedNotes.filter((note) => note.subject === subject).length;
        const extraCount = wrongNotes.filter((note) => note.subject === subject && (note.sourceType === "similar" || note.sourceType === "advanced")).length;

        const card = document.createElement("div");
        card.className = "stats-card";
        card.innerHTML = `
            <div class="stats-title">${escapeHtml(subject)}</div>
            <div class="stats-line">오답: ${wrongCount}개</div>
            <div class="stats-line">복습완료: ${solvedCount}개</div>
            <div class="stats-line">유사/응용 풀이: ${extraCount}개</div>
        `;
        box.appendChild(card);
    });

    if (plan === "premium8900") {
        weaknessBox.hidden = false;
        if (dashboardState.weakestSubject) {
            weaknessBox.textContent = `현재 가장 약한 과목: ${dashboardState.weakestSubject} / 이 과목을 먼저 복습하는 것이 좋습니다.`;
        } else {
            weaknessBox.textContent = "아직 누적 데이터가 적습니다. 오답이 쌓이면 약한 과목을 자동으로 보여줍니다.";
        }
    } else {
        weaknessBox.hidden = true;
    }
}

function updateCounts() {
    const wrongNotes = dashboardState?.wrongNotes || [];
    const solvedNotes = dashboardState?.solvedNotes || [];
    const filteredNotes = getFilteredAndSortedWrongNotes();

    $("wrongCount").textContent = `오답 개수: ${wrongNotes.length}`;
    $("solvedCount").textContent = `복습완료 개수: ${solvedNotes.length}`;
    $("filterCount").textContent = `현재 보기: ${$("filterSubject").value} / ${filteredNotes.length}개`;
}

function renderDashboard(dashboard) {
    dashboardState = dashboard;

    const remainAi = Math.max(0, dashboard.planRule.aiDaily - dashboard.usageAi.count);
    const storageText = dashboard.planRule.storageLimit === Infinity
        ? "무제한"
        : `${dashboard.wrongNotes.length}/${dashboard.planRule.storageLimit}`;

    $("welcomeText").textContent = `${dashboard.user.name}님 / ${getPlanLabel(dashboard.user.plan)} 요금제`;
    $("usageText").textContent = `남은 AI 분석: ${remainAi} / 하루 제한: ${dashboard.planRule.aiDaily}`;
    $("slotText").textContent = `저장 현황: ${storageText}`;

    updatePlanLocks();
    renderRecommendedReviews();
    renderSummaryStats();
    renderSubjectStats();
    renderWrongList();
    renderSolvedList();
    updateCounts();
    updateModeUI();
}

async function api(url, method = "GET", body = null) {
    const options = {
        method,
        headers: {}
    };

    if (body) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw new Error(data.error || "요청 중 오류가 발생했습니다.");
    }

    return data;
}

function showLoginTab() {
    $("showLoginTab").classList.add("active");
    $("showRegisterTab").classList.remove("active");
    $("loginBox").hidden = false;
    $("registerBox").hidden = true;
    showAuthMessage("");
}

function showRegisterTab() {
    $("showLoginTab").classList.remove("active");
    $("showRegisterTab").classList.add("active");
    $("loginBox").hidden = true;
    $("registerBox").hidden = false;
    showAuthMessage("");
}

async function register() {
    try {
        const data = await api("/api/auth/register", "POST", {
            name: $("registerName").value,
            email: $("registerEmail").value,
            password: $("registerPassword").value
        });

        $("authCard").hidden = true;
        $("appShell").hidden = false;

        clearInputs();
        currentAnalysisState = null;
        activeModeState = null;

        renderDashboard(data.dashboard);
        showMessage(data.message, "green");
    } catch (error) {
        showAuthMessage(error.message, "red");
    }
}

async function login() {
    try {
        const data = await api("/api/auth/login", "POST", {
            email: $("loginEmail").value,
            password: $("loginPassword").value
        });

        $("authCard").hidden = true;
        $("appShell").hidden = false;

        clearInputs();
        currentAnalysisState = null;
        activeModeState = null;

        renderDashboard(data.dashboard);
        showMessage(data.message, "green");
    } catch (error) {
        showAuthMessage(error.message, "red");
    }
}

async function logout() {
    try {
        await api("/api/auth/logout", "POST");
    } catch {}

    dashboardState = null;
    currentAnalysisState = null;
    activeModeState = null;
    clearInputs();

    $("authCard").hidden = false;
    $("appShell").hidden = true;
    showAuthMessage("로그아웃되었습니다.", "blue");
}

async function loadMe() {
    try {
        const data = await api("/api/auth/me");

        $("authCard").hidden = true;
        $("appShell").hidden = false;

        clearInputs();
        currentAnalysisState = null;
        activeModeState = null;

        renderDashboard(data.dashboard);
    } catch {
        $("authCard").hidden = false;
        $("appShell").hidden = true;
    }
}

async function changePlan(plan) {
    try {
        const data = await api("/api/plan/test-change", "POST", { plan });
        renderDashboard(data.dashboard);
        applyPlanToCurrentAnalysis();
        showMessage("요금제가 변경되어 현재 분석 화면도 새 기준으로 조정되었습니다.", "blue");
    } catch (error) {
        showMessage(error.message, "red");
    }
}

async function resetUsage() {
    try {
        const data = await api("/api/test/reset-usage", "POST");
        renderDashboard(data.dashboard);
        showMessage(data.message, "blue");
    } catch (error) {
        showMessage(error.message, "red");
    }
}

async function analyze() {
    const subject = $("subject").value;
    const problem = $("problem").value.trim();
    const userAnswer = $("userAnswer").value.trim();
    const correctAnswer = $("correctAnswer").value.trim();

    if (!subject || !problem || !userAnswer || !correctAnswer) {
        showMessage("과목, 문제, 내 답, 정답을 모두 입력해주세요.", "red");
        return;
    }

    const rule = getCurrentPlanRule();

    if (!rule.duplicateAnalyze) {
        const exists = (dashboardState?.wrongNotes || []).some(
            (note) =>
                note.subject === subject &&
                note.problem === problem &&
                note.correctAnswer === correctAnswer
        );

        if (exists) {
            showMessage("무료 요금제에서는 같은 문제를 다시 분석할 수 없습니다.", "red");
            return;
        }
    }

    setLoading(true);
    showMessage("AI 분석 중입니다...", "blue");

    try {
        const data = await api("/api/analyze", "POST", {
            subject,
            problem,
            userAnswer,
            correctAnswer
        });

        currentAnalysisState = data.analysis;
        renderDashboard(data.dashboard);
        applyPlanToCurrentAnalysis();
        showMessage(data.message, "green");
    } catch (error) {
        showMessage(error.message, "red");
    } finally {
        setLoading(false);
    }
}

async function generateAdvancedProblem() {
    const subject = $("subject").value;
    const problem = $("problem").value.trim();

    if (!problem) {
        showMessage("먼저 문제를 입력해주세요.", "red");
        return;
    }

    try {
        showMessage("응용문제를 생성 중입니다...", "blue");

        const data = await api("/api/advanced-problem", "POST", {
            subject,
            problem
        });

        if (!currentAnalysisState) {
            currentAnalysisState = {
                reason: "아직 분석 결과가 없습니다.",
                concept: "아직 분석 결과가 없습니다.",
                solution: "아직 분석 결과가 없습니다.",
                similarProblems: [],
                advancedProblem: data.advancedProblem
            };
        } else {
            currentAnalysisState.advancedProblem = data.advancedProblem;
        }

        renderDashboard(data.dashboard);
        applyPlanToCurrentAnalysis();
        showMessage(data.message, "green");
    } catch (error) {
        showMessage(error.message, "red");
    }
}

async function checkAnswer() {
    const subject = $("subject").value;
    const problem = $("problem").value.trim();
    const userAnswer = $("userAnswer").value.trim();
    const correctAnswer = $("correctAnswer").value.trim();

    if (!subject || !problem || !userAnswer || !correctAnswer) {
        showMessage("과목, 문제, 내 답, 정답을 모두 입력해주세요.", "red");
        return;
    }

    try {
        const data = await api("/api/notes/check", "POST", {
            subject,
            problem,
            userAnswer,
            correctAnswer,
            currentAnalysis: currentAnalysisState,
            sourceType: activeModeState?.type || "normal"
        });

        if (data.dashboard) {
            renderDashboard(data.dashboard);
        }

        showMessage(data.message, userAnswer === correctAnswer ? "green" : "red");

        if (data.clearInputs) {
            clearInputs();
        }
    } catch (error) {
        showMessage(error.message, "red");
    }
}

async function deleteWrongNote(id) {
    try {
        const data = await api("/api/notes/delete", "POST", { id });
        renderDashboard(data.dashboard);
        showMessage(data.message, "blue");
    } catch (error) {
        showMessage(error.message, "red");
    }
}

async function clearAllWrongNotes() {
    try {
        const data = await api("/api/notes/clear", "POST");
        renderDashboard(data.dashboard);
        showMessage(data.message, "blue");
    } catch (error) {
        showMessage(error.message, "red");
    }
}

async function deleteSolvedNote(id) {
    try {
        const data = await api("/api/solved/delete", "POST", { id });
        renderDashboard(data.dashboard);
        showMessage(data.message, "blue");
    } catch (error) {
        showMessage(error.message, "red");
    }
}

async function restoreSolvedNote(id) {
    try {
        const data = await api("/api/solved/restore", "POST", { id });
        renderDashboard(data.dashboard);
        showMessage(data.message, "blue");
    } catch (error) {
        showMessage(error.message, "red");
    }
}

function retryWrongNote(id) {
    const note = (dashboardState?.wrongNotes || []).find((item) => item.id === id);
    if (!note) return;

    $("subject").value = note.subject;
    $("problem").value = note.problem;
    $("userAnswer").value = note.userAnswer;
    $("correctAnswer").value = note.correctAnswer;

    currentAnalysisState = {
        reason: note.reason,
        concept: note.concept,
        solution: note.solution,
        similarProblems: note.similarProblems || [],
        advancedProblem: note.advancedProblem || "아직 응용문제가 없습니다."
    };

    if (note.sourceType === "similar" || note.sourceType === "advanced") {
        activeModeState = { type: note.sourceType };
    } else {
        activeModeState = null;
    }

    applyPlanToCurrentAnalysis();
    renderCurrentAnalysis();
    updateModeUI();

    const rule = getCurrentPlanRule();
    if (!rule.duplicateAnalyze) {
        showMessage("다시풀기를 불러왔습니다. 무료 요금제에서는 같은 문제 재분석이 제한됩니다.", "blue");
    } else {
        showMessage("오답을 다시 불러왔습니다.", "blue");
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
}

function getSectionState(key, defaultValue = false) {
    const saved = localStorage.getItem(key);
    if (saved === null) return defaultValue;
    return saved === "true";
}

function setSectionState(key, value) {
    localStorage.setItem(key, String(value));
}

function updateSectionToggle(sectionId, buttonId, collapsed) {
    const section = $(sectionId);
    const button = $(buttonId);

    if (!section || !button) return;

    section.hidden = collapsed;
    button.textContent = collapsed ? "펼치기" : "접기";
}

function toggleWrongSection() {
    const next = !getSectionState("wrongSectionCollapsed", false);
    setSectionState("wrongSectionCollapsed", next);
    updateSectionToggle("wrongSectionBody", "toggleWrongBtn", next);
}

function toggleSolvedSection() {
    const next = !getSectionState("solvedSectionCollapsed", false);
    setSectionState("solvedSectionCollapsed", next);
    updateSectionToggle("solvedSectionBody", "toggleSolvedBtn", next);
}

function applySectionStates() {
    updateSectionToggle(
        "wrongSectionBody",
        "toggleWrongBtn",
        getSectionState("wrongSectionCollapsed", false)
    );

    updateSectionToggle(
        "solvedSectionBody",
        "toggleSolvedBtn",
        getSectionState("solvedSectionCollapsed", false)
    );
}

document.addEventListener("DOMContentLoaded", () => {
    $("showLoginTab").addEventListener("click", showLoginTab);
    $("showRegisterTab").addEventListener("click", showRegisterTab);
    $("registerBtn").addEventListener("click", register);
    $("loginBtn").addEventListener("click", login);
    $("logoutBtn").addEventListener("click", logout);

    $("checkBtn").addEventListener("click", checkAnswer);
    $("analyzeBtn").addEventListener("click", analyze);
    $("generateAdvancedBtn").addEventListener("click", generateAdvancedProblem);

    $("useAdvancedProblemBtn").addEventListener("click", () => {
        const advanced = currentAnalysisState?.advancedProblem;
        if (!advanced || advanced === "아직 응용문제가 없습니다.") {
            showMessage("먼저 응용문제를 생성하세요.", "red");
            return;
        }

        $("problem").value = advanced;
        $("userAnswer").value = "";
        $("correctAnswer").value = "";
        activeModeState = { type: "advanced" };
        updateModeUI();
        showMessage("응용문제를 불러왔습니다. 정답을 직접 입력하고 채점하세요.", "blue");
    });

    $("clearInputsBtn").addEventListener("click", () => {
        clearInputs();
        showMessage("입력을 초기화했습니다.", "blue");
    });

    $("exitModeBtn").addEventListener("click", () => {
        clearActiveMode();
        showMessage("풀이 모드를 종료했습니다.", "blue");
    });

    $("planFree").addEventListener("click", () => changePlan("free"));
    $("plan5900").addEventListener("click", () => changePlan("premium5900"));
    $("plan8900").addEventListener("click", () => changePlan("premium8900"));
    $("resetUsageBtn").addEventListener("click", resetUsage);
    $("clearAllBtn").addEventListener("click", clearAllWrongNotes);

    $("filterSubject").addEventListener("change", () => {
        renderWrongList();
        updateCounts();
    });

    $("searchInput").addEventListener("input", () => {
        renderWrongList();
        updateCounts();
    });

    $("sortType").addEventListener("change", () => {
        renderWrongList();
        updateCounts();
    });

    $("toggleWrongBtn").addEventListener("click", toggleWrongSection);
    $("toggleSolvedBtn").addEventListener("click", toggleSolvedSection);

    applySectionStates();
    loadMe();
});

document
.getElementById("feedbackBtn")
?.addEventListener("click",()=>{

alert(
"불편한 점을 개발자에게 말해주세요!"
);

});

document.querySelectorAll("button").forEach(btn=>{
if(
btn.textContent.includes("테스트 리셋")
){
btn.style.display="none";
}
});