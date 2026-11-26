let dashboardState = null;
let currentAnalysisState = null;
let activeModeState = null;
let isAnalyzeRequestRunning = false;
// =====================================
// 문제 사진 상태
// =====================================

let selectedProblemImage = null;
let selectedProblemImageKey = "";
// ScorePath: 최대 3장 크롭 사진, 저장 및 복습은 한 장의 묶음 이미지로 유지
let scorePathPhotoPartsV01 = [];

let imageCropState = {
    sourceDataUrl: "",
    startX: 0,
    startY: 0,
    endX: 0,
    endY: 0,
    dragging: false
};


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
    if (["premium9900", "premium5900", "premium8900"].includes(plan)) {
        return "9,900원 유료";
    }
    return "무료";
}

function getCurrentPlanRule() {
    return dashboardState?.planRule || {
        aiDaily: 5,
        advancedDaily: 0,
        storageLimit: 50,
        similarCount: 1,
        reviewEnabled: false,
        duplicateAnalyze: false,
        advancedEnabled: false
    };
}

function updateModeUI() {
    const isSimilar =
        activeModeState?.type === "similar";

    const isAdvanced =
        activeModeState?.type === "advanced";

    const isScheduledReview =
        activeModeState?.type === "scheduled_review";

    const isWeaknessTraining =
        activeModeState?.type === "weakness_training";

    const hasMode =
        isSimilar ||
        isAdvanced ||
        isScheduledReview ||
        isWeaknessTraining;

    $("similarModeText").hidden =
        !isSimilar;

    $("advancedModeText").hidden =
        !isAdvanced;

    $("exitModeBtn").hidden =
        !hasMode;
}

function clearActiveMode() {
    activeModeState = null;
    updateModeUI();
}

function clearInputs() {
    $("problem").value = "";
    $("userAnswer").value = "";
    $("correctAnswer").value = "";

    if (
        selectedProblemImage
            ?.previewUrl
    ) {
        URL.revokeObjectURL(
            selectedProblemImage.previewUrl
        );
    }

    selectedProblemImage = null;
    scorePathPhotoPartsV01 = [];
selectedProblemImageKey = "";

renderSelectedProblemImage();

    currentAnalysisState = null;

    clearActiveMode();

    renderCurrentAnalysis();
}

function blobToDataUrl(blob) {
    return new Promise(
        (resolve, reject) => {
            const reader =
                new FileReader();

            reader.onload =
                () =>
                    resolve(
                        reader.result
                    );

            reader.onerror =
                () =>
                    reject(
                        new Error(
                            "사진을 읽지 못했습니다."
                        )
                    );

            reader.readAsDataURL(blob);
        }
    );
}


async function uploadSelectedProblemImage() {
    if (
        !selectedProblemImage
            ?.blob
    ) {
        return null;
    }

    const imageBase64 =
        await blobToDataUrl(
            selectedProblemImage.blob
        );

    const data =
        await api(
            "/api/problem-image/upload",
            "POST",
            {
                imageBase64,

                contentType:
                    selectedProblemImage
                        .blob
                        .type ||
                    "image/webp"
            }
        );

    return data;
}

// =====================================
// ScorePath 21-85
// 기존 문제은행 화면
// =====================================

async function openScorePathProblemBankV01() {

    let data;

    try {

        data = await api(
            "/api/scorepath/problem-bank"
        );

    } catch (error) {

        showMessage(
            error.message ||
            "문제은행을 불러오지 못했습니다.",
            "red"
        );

        return;
    }

    const items =
        Array.isArray(data.items)
            ? data.items
            : [];

    $("scorePathBankOverlay")?.remove();

    const overlay =
        document.createElement("div");

    overlay.id =
        "scorePathBankOverlay";

    overlay.style.cssText =
        "position:fixed;inset:0;background:#0009;" +
        "z-index:9999;display:flex;align-items:center;" +
        "justify-content:center;padding:12px;";

    overlay.innerHTML = `
        <div style="
            background:white;
            color:#222;
            border-radius:12px;
            padding:16px;
            width:min(700px,100%);
            max-height:88vh;
            overflow:auto;
        ">

            <div style="
                display:flex;
                justify-content:space-between;
                align-items:center;
                gap:12px;
            ">
                <strong>
                    📚 기존 문제은행
                    · ${Number(data.totalRecords) || 0}개 기록
                    / ${items.length}개 묶음
                </strong>

                <button type="button" data-bank-close>
                    닫기
                </button>
            </div>

            <p style="font-size:13px;">
                기존 문제를 다시 활용할 수 있습니다.
                같은 사진도 저장 키가 다르면 별도로 표시될 수 있습니다.
            </p>

            <input
                data-bank-search
                placeholder="과목, 단원, 문제 내용 검색"
                style="
                    width:100%;
                    padding:9px;
                    box-sizing:border-box;
                "
            >

            <div
                data-bank-list
                style="margin-top:12px;"
            ></div>

            <button
                type="button"
                data-bank-more
                style="margin-top:10px;"
            >
                20개 더 보기
            </button>

        </div>
    `;

    document.body.appendChild(overlay);

    let visibleCount = 20;
    let visibleItems = [];

    const search =
        overlay.querySelector("[data-bank-search]");

    const list =
        overlay.querySelector("[data-bank-list]");

    const more =
        overlay.querySelector("[data-bank-more]");


    // =====================================
    // 문제 목록 출력
    // =====================================

    function render() {

        const query =
            search.value.trim().toLowerCase();

        const matches =
            items.filter((item) =>

                [
                    item.subject,
                    item.unit,
                    item.problem
                ].some((value) =>

                    String(value || "")
                        .toLowerCase()
                        .includes(query)
                )
            );

        visibleItems =
            matches.slice(0, visibleCount);

        list.innerHTML =
            visibleItems.length
                ? visibleItems.map((item, index) => `

                    <div style="
                        border:1px solid #ddd;
                        padding:10px;
                        margin:8px 0;
                        border-radius:8px;
                    ">

                        <div>
                            <strong>
                                ${escapeHtml(item.subject || "기타")}
                            </strong>

                            · ${escapeHtml(item.unit || "단원 미지정")}

                            · 기록 ${Number(item.recordCount) || 1}개
                        </div>

                        <div style="
                            white-space:pre-wrap;
                            overflow-wrap:anywhere;
                            margin:7px 0;
                        ">
                            ${escapeHtml(
                                String(
                                    item.problem || "[사진 문제]"
                                ).slice(0, 300)
                            )}
                        </div>

                        ${
                            item.problemImageKey
                                ? `
                                    <img
                                        loading="lazy"
                                        alt="저장된 문제 사진"
                                        src="/api/problem-image?key=${encodeURIComponent(
                                            item.problemImageKey
                                        )}"
                                        style="
                                            display:block;
                                            max-width:100%;
                                            max-height:160px;
                                            object-fit:contain;
                                            margin:6px 0;
                                        "
                                    >
                                `
                                : ""
                        }

                        <button
                            type="button"
                            data-bank-use="${index}"
                            ${
                                item.correctAnswers.length !== 1
                                    ? "disabled"
                                    : ""
                            }
                        >
                            다시 풀기
                        </button>

                        ${
                            item.correctAnswers.length !== 1
                                ? `
                                    <small>
                                        정답 기록이 없거나 서로 달라 선택 보류
                                    </small>
                                `
                                : ""
                        }

                    </div>

                `).join("")
                : "일치하는 문제가 없습니다.";

                more.hidden =
            matches.length <= visibleCount;

        // =====================================
        // ScorePath 21-95
        // 기존 문제 정답 수정 버튼
        // =====================================

        list.querySelectorAll(
            "[data-bank-use]"
        ).forEach(
            (useButton, index) => {

                const item =
                    visibleItems[index];

                if (!item) {
                    return;
                }

                const correctButton =
                    document.createElement("button");

                correctButton.type =
                    "button";

                correctButton.textContent =
                    "✏️ 정답 수정";

                correctButton.style.marginLeft =
                    "8px";

                useButton.insertAdjacentElement(
                    "afterend",
                    correctButton
                );

                correctButton.addEventListener(
                    "click",
                    async () => {

                        const entered =
                            prompt(
                                "실제 정답을 공식 해설 등으로 " +
                                "확인한 뒤 입력하세요.\n" +
                                "현재 저장된 정답:",

                                item.correctAnswer ||
                                item.correctAnswers?.[0] ||
                                ""
                            );

                        if (entered === null) {
                            return;
                        }

                        const answer =
                            entered.trim();

                        if (!answer) {
                            alert(
                                "정답을 입력해주세요."
                            );

                            return;
                        }

                        const confirmed =
                            confirm(
                                `정답을 '${answer}'(으)로 ` +
                                `수정할까요?\n` +

                                "과거 ScorePath 풀이 기록은 " +
                                "재채점되지만, 기존 오답·휴지통 " +
                                "원본은 보존됩니다."
                            );

                        if (!confirmed) {
                            return;
                        }

                        correctButton.disabled =
                            true;

                        try {

                            const result =
                                await api(
                                    "/api/scorepath/problem-bank/correct-answer",

                                    "POST",

                                    {
                                        subject:
                                            item.subject,

                                        problem:
                                            item.problem,

                                        problemImageKey:
                                            item.problemImageKey,

                                        correctAnswer:
                                            answer
                                    }
                                );

                            item.correctAnswer =
                                result.correctAnswer;

                            item.correctAnswers =
                                [result.correctAnswer];

                            render();

                            alert(
                                result.message
                            );

                        } catch (error) {

                            correctButton.disabled =
                                false;

                            alert(
                                error.message ||
                                "정답 수정에 실패했습니다."
                            );
                        }
                    }
                );
            }
        );
    }


    search.addEventListener("input", () => {

        visibleCount = 20;

        render();
    });


    more.addEventListener("click", () => {

        visibleCount += 20;

        render();
    });


    // =====================================
    // 문제 선택
    // =====================================

    overlay.addEventListener("click", async (event) => {

        if (
            event.target === overlay ||
            event.target.closest("[data-bank-close]")
        ) {

            overlay.remove();

            return;
        }

        const button =
            event.target.closest("[data-bank-use]");

        if (!button) {
            return;
        }

        const item =
            visibleItems[
                Number(button.dataset.bankUse)
            ];

        if (!item || !item.correctAnswer) {
            return;
        }

        const subject =
            $("subject");

        const exam =
            $("scorePathExam");

        // 현재 시험과 과목이 다르면 연결하지 않는다.
        if (
            exam?.value &&
            subject?.value !== item.subject
        ) {

            showMessage(
                "현재 시험의 과목과 다른 문제입니다. " +
                "다른 시험을 선택하거나 연결을 해제하세요.",
                "red"
            );

            return;
        }

        if (
            !subject ||
            ![...subject.options].some(
                (opt) => opt.value === item.subject
            )
        ) {

            showMessage(
                "이 문제의 과목을 먼저 과목 목록에 추가해 주세요.",
                "red"
            );

            return;
        }

        button.disabled = true;

        try {

            // 기존 입력 상태 초기화
            clearInputs();

            // 기존 문제 불러오기
            subject.value =
                item.subject;

            $("problem").value =
                item.problem ||
                `[기존 사진 문제] ${item.problemImageKey}`;

            $("correctAnswer").value =
                item.correctAnswer;

            // 기존 내 답은 재사용하지 않는다.
            $("userAnswer").value = "";

            // 기존 R2 사진 불러오기
            if (item.problemImageKey) {

                await loadStoredProblemImage(
                    item.problemImageKey
                );
            }

            // 일치하는 단원이 있다면 자동 선택
            if (
                $("scorePathUnit") &&
                item.unit &&
                [...$("scorePathUnit").options].some(
                    (opt) => opt.value === item.unit
                )
            ) {

                $("scorePathUnit").value =
                    item.unit;
            }

            // =====================================
            // ScorePath 21-139
            // 기존 문제은행 → 학습 화면 연결
            // =====================================

            // 문제은행 창 닫기
            overlay.remove();

            // 학습 화면 먼저 표시
            setScorePathMainNavigationV01(
                "study"
            );

            // 문제 입력 위치로 이동
            requestAnimationFrame(() => {

                $("problem")?.scrollIntoView({
                    behavior: "smooth",
                    block: "center"
                });

                $("userAnswer")?.focus({
                    preventScroll: true
                });

            });

            showMessage(
                "기존 문제를 불러왔습니다. " +
                "내 답을 입력한 후 정답 확인을 누르세요.",
                "green"
            );

        } catch (error) {

            button.disabled = false;

            showMessage(
                error.message ||
                "사진을 불러오지 못했습니다.",
                "red"
            );
        }

    });

    render();
}


// =====================================
// 기존 사진 불러오기 함수
// =====================================

async function loadStoredProblemImage(
    problemImageKey
) {
    const cleanKey =
        String(
            problemImageKey || ""
        ).trim();

    if (!cleanKey) {
        return false;
    }

    const response =
        await fetch(
            `/api/problem-image?key=${encodeURIComponent(
                cleanKey
            )}`,
            {
                credentials: "include"
            }
        );

    if (!response.ok) {
        throw new Error(
            "저장된 문제 사진을 불러오지 못했습니다."
        );
    }

    const blob =
        await response.blob();

    if (
        selectedProblemImage
            ?.previewUrl
    ) {
        URL.revokeObjectURL(
            selectedProblemImage.previewUrl
        );
    }

    const previewUrl =
        URL.createObjectURL(blob);

    scorePathPhotoPartsV01 = [];
    selectedProblemImage = {
        blob,
        previewUrl,
        width: 0,
        height: 0,
        size: blob.size,
        type:
            blob.type ||
            "image/webp"
    };

    selectedProblemImageKey =
        cleanKey;

    renderSelectedProblemImage();

    return true;
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

// =====================================
// ScorePath 21-367
// 응용문제 SVG 자동 생성 V1
// =====================================

function renderScorePathAdvancedSvgV01(problemText) {
    const box = $("advancedProblemBox");
    if (!box) return;

    const source = String(problemText || "");

    // 삼각형과 직각 조건 찾기
    const triangle = source.match(
        /삼각형\s*([A-Z]{3})/i
    );

    const angle = source.match(
        /(?:∠|\\angle\s*)([A-Z]{3})\s*=\s*(?:π\s*\/\s*2|\\pi\s*\/\s*2|\\frac\s*\{\s*\\pi\s*\}\s*\{\s*2\s*\}|90\s*(?:°|도|\\circ)?)/i
    );

    if (!triangle || !angle) return;

    const points = triangle[1]
        .toUpperCase()
        .split("");

    const anglePoints = angle[1]
        .toUpperCase()
        .split("");

    const right = anglePoints[1];

    if (
        new Set(points).size !== 3 ||
        new Set(anglePoints).size !== 3 ||
        !anglePoints.every(v => points.includes(v))
    ) {
        return;
    }

    const [top, end] = points.filter(
        v => v !== right
    );

    let vertical = 120;
    let horizontal = 180;
    let hasRatio = false;

    // 직각변의 비율 찾기
    const compact = source.replace(/\s+/g, "");

    const ratio = compact.match(
        /([A-Z]{2}):([A-Z]{2})=(\d+(?:\.\d+)?|√\d+):(\d+(?:\.\d+)?|√\d+)/i
    );

    if (ratio) {
        const numberOf = value =>
            value.startsWith("√")
                ? Math.sqrt(Number(value.slice(1)))
                : Number(value);

        const legs = {};

        for (let i = 1; i <= 2; i++) {
            const segment = ratio[i].toUpperCase();
            const value = numberOf(ratio[i + 2]);

            if (
                segment.includes(right) &&
                Number.isFinite(value) &&
                value > 0
            ) {
                const other = segment.replace(right, "");

                if (other.length === 1) {
                    legs[other] = value;
                }
            }
        }

        if (legs[top] && legs[end]) {
            const scale =
                155 / Math.max(legs[top], legs[end]);

            vertical = Math.max(
                20,
                legs[top] * scale
            );

            horizontal = Math.max(
                20,
                legs[end] * scale
            );

            hasRatio = true;
        }
    }

    // SVG 생성
    const ns = "http://www.w3.org/2000/svg";

    const node = (tag, attrs = {}, label = "") => {
        const item = document.createElementNS(ns, tag);

        for (const [key, value] of Object.entries(attrs)) {
            item.setAttribute(key, String(value));
        }

        if (label) {
            item.textContent = label;
        }

        return item;
    };

    const x = 70;
    const y = 175;

    const svg = node("svg", {
        viewBox: "0 0 310 225",
        role: "img",
        "aria-label":
            `직각삼각형 ${points.join("")}, ${right}에서 직각`,
        style:
            "display:block;width:100%;max-width:340px;" +
            "height:auto;margin:12px 0"
    });

    // 삼각형
    svg.appendChild(node("polygon", {
        points:
            `${x},${y - vertical} ` +
            `${x},${y} ` +
            `${x + horizontal},${y}`,
        fill: "#eff6ff",
        stroke: "#2563eb",
        "stroke-width": 2.5,
        "stroke-linejoin": "round"
    }));

    // 직각 표시
    svg.appendChild(node("path", {
        d: `M${x},${y - 15} H${x + 15} V${y}`,
        fill: "none",
        stroke: "#2563eb",
        "stroke-width": 1.6
    }));

    // 꼭짓점 이름
    const labels = [
        [top, x - 17, y - vertical - 8],
        [right, x - 22, y + 21],
        [end, x + horizontal + 8, y + 20]
    ];

    for (const [name, tx, ty] of labels) {
        svg.appendChild(node("text", {
            x: tx,
            y: ty,
            "font-size": 18,
            "font-family": "Arial, sans-serif",
            fill: "#1e293b"
        }, name));
    }

    svg.appendChild(node("text", {
        x: x + 20,
        y: y - 7,
        "font-size": 12,
        fill: "#334155"
    }, "90°"));

    // 그림 설명
    svg.appendChild(node("text", {
        x: 12,
        y: 216,
        "font-size": 12,
        fill: "#64748b"
    }, hasRatio
        ? "조건의 두 직각변 비율을 반영한 개념도"
        : "개념도 · 실제 길이 비율 미반영"
    ));

    box.appendChild(svg);
}

// ==================================================
// ScorePath 21-368: 응용문제용 SVG 도식 V2
// 일반 삼각형 / 직각삼각형(+외접원) / 원 / 1~3차 다항함수 그래프
// 별도 AI 호출·비신뢰 HTML·eval 사용 없음
// ==================================================

function renderScorePathAdvancedSvgV02(problemText) {

    const box = $("advancedProblemBox");
    if (!box) return;

    // 이전 그림 중복 방지
    box.querySelectorAll(
        '[data-scorepath-svg="v2"]'
    ).forEach(el => el.remove());

    const source = String(problemText || "");
    const compact = source.replace(/\s+/g, "");

    if (!source.trim()) return;

    const ns = "http://www.w3.org/2000/svg";

    const el = (tag, attrs = {}, label) => {

        const result =
            document.createElementNS(ns, tag);

        Object.entries(attrs).forEach(([k, v]) =>
            result.setAttribute(k, String(v))
        );

        if (label !== undefined) {
            result.textContent = String(label);
        }

        return result;
    };

    const svgBase = (description) => el("svg", {
        viewBox: "0 0 340 255",
        role: "img",
        "aria-label": description,
        "data-scorepath-svg": "v2",
        style:
            "display:block;width:100%;" +
            "max-width:390px;height:auto;margin:12px 0"
    });

    const textAt = (
        svg,
        x,
        y,
        label,
        size = 15
    ) => {

        svg.appendChild(el("text", {
            x,
            y,
            "font-size": size,
            fill: "#24364b",
            "font-family": "Arial,sans-serif"
        }, label));
    };

    const subtitle = (svg, label) =>
        textAt(svg, 9, 246, label, 11);

    const finite = n => Number.isFinite(n);

    const parseNumber = raw => {

        const s = String(raw || "")
            .replace(/\\sqrt\{(\d+)\}/g, "√$1");

        if (/^√\d+(?:\.\d+)?$/.test(s)) {
            return Math.sqrt(Number(s.slice(1)));
        }

        return /^\d+(?:\.\d+)?$/.test(s)
            ? Number(s)
            : NaN;
    };


    // =====================================
    // 1. 삼각형 SVG
    // =====================================

    const triangleMatch = source.match(
        /삼각형\s*([A-Z]{3})/i
    );

    if (triangleMatch) {

        const names = triangleMatch[1]
            .toUpperCase()
            .split("");

        if (new Set(names).size !== 3) {
            return;
        }

        // 각도 조건 확인
        const angleMatch = source.match(
            /(?:∠|\\angle\s*)([A-Z]{3})\s*=\s*(90\s*(?:°|도|\\circ)?|\d+(?:\.\d+)?\s*(?:°|도)|(?:2\s*)?(?:π|\\pi)\s*\/\s*[236]|\\frac\s*\{\s*(?:π|\\pi)\s*\}\s*\{\s*[236]\s*\})/i
        );

        let vertex = names[1];
        let angleDegrees = 65;
        let explicitAngle = false;

        if (angleMatch) {

            const ordered = angleMatch[1]
                .toUpperCase()
                .split("");

            if (
                new Set(ordered).size === 3 &&
                ordered.every(v => names.includes(v))
            ) {

                vertex = ordered[1];

                const value = angleMatch[2]
                    .replace(/\s+/g, "");

                const degrees = value.match(
                    /^(\d+(?:\.\d+)?)(?:°|도)?$/
                );

                const fraction = value.match(
                    /^(2)?(?:π|\\pi)\/(2|3|6)$/i
                );

                const latex = value.match(
                    /^\\frac\{(?:π|\\pi)\}\{(2|3|6)\}$/i
                );

                let candidate = degrees
                    ? Number(degrees[1])
                    : fraction
                        ? 180 *
                          (fraction[1] ? 2 : 1) /
                          Number(fraction[2])
                        : latex
                            ? 180 / Number(latex[1])
                            : NaN;

                if (
                    finite(candidate) &&
                    candidate > 0 &&
                    candidate < 180
                ) {

                    explicitAngle = true;
                    angleDegrees = candidate;
                }
            }
        }

        const [first, last] = names.filter(
            v => v !== vertex
        );

        // 두 변의 비율 확인
        const ratio = compact.match(
            /([A-Z]{2}):([A-Z]{2})=(\d+(?:\.\d+)?|√\d+(?:\.\d+)?|\\sqrt\{\d+\}):(\d+(?:\.\d+)?|√\d+(?:\.\d+)?|\\sqrt\{\d+\})/i
        );

        const legs = {};

        if (ratio) {

            for (let i = 1; i <= 2; i++) {

                const side = ratio[i]
                    .toUpperCase();

                const value = parseNumber(
                    ratio[i + 2]
                );

                if (
                    side.length === 2 &&
                    side.includes(vertex) &&
                    finite(value) &&
                    value > 0
                ) {

                    const other = side.replace(
                        vertex,
                        ""
                    );

                    if (other.length === 1) {
                        legs[other] = value;
                    }
                }
            }
        }

        const ratioKnown = Boolean(
            legs[first] && legs[last]
        );

        const ratioFirst = ratioKnown
            ? legs[first]
            : 1;

        const ratioLast = ratioKnown
            ? legs[last]
            : 1.25;

        const scale = 150 / Math.max(
            ratioFirst,
            ratioLast
        );

        const lengthFirst =
            ratioFirst * scale;

        const lengthLast =
            ratioLast * scale;

        const theta =
            angleDegrees * Math.PI / 180;

        // 꼭짓점 좌표 계산
        const Q = {
            x: 115,
            y: 180
        };

        let A = {
            x: Q.x + lengthFirst * Math.cos(theta),
            y: Q.y - lengthFirst * Math.sin(theta)
        };

        let B = {
            x: Q.x + lengthLast,
            y: Q.y
        };

        // 그림 중앙 정렬
        const xmin = Math.min(
            Q.x, A.x, B.x
        );

        const xmax = Math.max(
            Q.x, A.x, B.x
        );

        const ymin = Math.min(
            Q.y, A.y, B.y
        );

        const ymax = Math.max(
            Q.y, A.y, B.y
        );

        const offsetX =
            170 - (xmin + xmax) / 2;

        const offsetY =
            115 - (ymin + ymax) / 2;

        const shift = p => ({
            x: p.x + offsetX,
            y: p.y + offsetY
        });

        const q = shift(Q);
        const a = shift(A);
        const b = shift(B);

        const svg = svgBase(
            `삼각형 ${names.join("")}의 ${vertex} 꼭짓점 도식`
        );

        // =====================================
        // 직각삼각형 외접원
        // =====================================

        if (
            Math.abs(angleDegrees - 90) < 0.001 &&
            explicitAngle &&
            /외접원/.test(source)
        ) {

            const cx =
                (a.x + b.x) / 2;

            const cy =
                (a.y + b.y) / 2;

            const r =
                Math.hypot(
                    a.x - b.x,
                    a.y - b.y
                ) / 2;

            svg.appendChild(el("circle", {
                cx,
                cy,
                r,
                fill: "none",
                stroke: "#85a4c4",
                "stroke-width": 1.5,
                "stroke-dasharray": "5 4"
            }));
        }

        // 삼각형 그리기
        svg.appendChild(el("polygon", {
            points:
                `${a.x},${a.y} ` +
                `${q.x},${q.y} ` +
                `${b.x},${b.y}`,
            fill: "#eff6ff",
            stroke: "#2563eb",
            "stroke-width": 2.4
        }));

        // 꼭짓점 이름 표시
        const placeLabel = (
            name,
            p,
            dx,
            dy
        ) => {

            textAt(
                svg,
                p.x + dx,
                p.y + dy,
                name,
                17
            );
        };

        placeLabel(
            first,
            a,
            -12,
            -9
        );

        placeLabel(
            vertex,
            q,
            -20,
            18
        );

        placeLabel(
            last,
            b,
            9,
            14
        );

        // =====================================
        // 직각 표시
        // =====================================

        if (
            Math.abs(angleDegrees - 90) < 0.001 &&
            explicitAngle
        ) {

            const d = 15;

            const ux =
                (a.x - q.x) /
                Math.hypot(
                    a.x - q.x,
                    a.y - q.y
                );

            const uy =
                (a.y - q.y) /
                Math.hypot(
                    a.x - q.x,
                    a.y - q.y
                );

            const vx =
                (b.x - q.x) /
                Math.hypot(
                    b.x - q.x,
                    b.y - q.y
                );

            const vy =
                (b.y - q.y) /
                Math.hypot(
                    b.x - q.x,
                    b.y - q.y
                );

            svg.appendChild(el("path", {
                d:
                    `M${q.x + ux*d},${q.y + uy*d} ` +
                    `L${q.x + (ux+vx)*d},${q.y + (uy+vy)*d} ` +
                    `L${q.x + vx*d},${q.y + vy*d}`,
                fill: "none",
                stroke: "#2563eb",
                "stroke-width": 1.4
            }));

        } else if (explicitAngle) {

            textAt(
                svg,
                q.x + 13,
                q.y - 14,
                `${angleDegrees}°`,
                12
            );
        }

        // 그림 설명
        subtitle(
            svg,
            ratioKnown && explicitAngle
                ? "명시된 각도·두 변 비율 반영 (크기는 임의)"
                : explicitAngle
                    ? "명시된 각도 반영 · 나머지 길이는 개념도"
                    : "개념도 · 실제 각도/길이 비율 미반영"
        );

        box.appendChild(svg);
        return;
    }


    // =====================================
    // 2. 다항함수 그래프 SVG
    // =====================================

    const exprHead = source.match(
        /(?:\b[fgh]\s*\(\s*x\s*\)|\by)\s*=\s*/i
    );

    if (exprHead) {

        const remaining = source.slice(
            exprHead.index + exprHead[0].length
        );

        let expr = remaining
            .split(/[\n,;가-힣()\\]/, 1)[0]
            .replace(/\^\{([0-9]+)\}/g, "^$1")
            .replace(/\s+/g, "");

        if (
            /^[+\-\d.xX^*]+$/.test(expr) &&
            /x/i.test(expr)
        ) {

            let terms = expr
                .replace(/-/g, "+-")
                .split("+")
                .filter(Boolean);

            const coefficients = [
                0, 0, 0, 0
            ];

            let valid = true;

            for (const term of terms) {

                if (
                    !term.includes("x") &&
                    !term.includes("X")
                ) {

                    if (
                        !/^[+-]?\d+(?:\.\d+)?$/.test(term)
                    ) {

                        valid = false;
                        break;
                    }

                    coefficients[0] += Number(term);
                    continue;
                }

                const match = term.match(
                    /^([+-]?(?:(?:\d+(?:\.\d+)?)?)?)\*?[xX](?:\^([123]))?$/
                );

                if (!match) {
                    valid = false;
                    break;
                }

                const coeff =
                    match[1] === "-"
                        ? -1
                        : (
                            match[1] === "" ||
                            match[1] === "+"
                        )
                            ? 1
                            : Number(match[1]);

                const power = match[2]
                    ? Number(match[2])
                    : 1;

                if (!finite(coeff)) {
                    valid = false;
                    break;
                }

                coefficients[power] += coeff;
            }

            if (
                valid &&
                coefficients.every(
                    v => finite(v) && Math.abs(v) < 1e7
                ) &&
                coefficients.slice(1).some(
                    v => v !== 0
                )
            ) {

                const fn = x =>
                    coefficients[0] +
                    coefficients[1] * x +
                    coefficients[2] * x * x +
                    coefficients[3] * x * x * x;

                const samples = Array.from(
                    {length: 161},
                    (_, i) => {

                        const x =
                            -4 + i * 0.05;

                        return {
                            x,
                            y: fn(x)
                        };
                    }
                );

                if (
                    !samples.every(
                        p => finite(p.y)
                    )
                ) {
                    return;
                }

                let minY = Math.min(
                    0,
                    ...samples.map(p => p.y)
                );

                let maxY = Math.max(
                    0,
                    ...samples.map(p => p.y)
                );

                const padding = Math.max(
                    1,
                    (maxY - minY) * 0.1
                );

                minY -= padding;
                maxY += padding;

                const xPx = x =>
                    38 + (x + 4) / 8 * 284;

                const yPx = y =>
                    208 -
                    (y - minY) /
                    (maxY - minY) * 182;

                const svg = svgBase(
                    `다항함수 y=${expr}의 -4부터 4까지 그래프`
                );

                // 세로 안내선
                for (
                    const tick of [-4, -2, 0, 2, 4]
                ) {

                    const px = xPx(tick);

                    svg.appendChild(el("line", {
                        x1: px,
                        y1: 19,
                        x2: px,
                        y2: 209,
                        stroke: "#e2e8f0",
                        "stroke-width": 1
                    }));

                    textAt(
                        svg,
                        px - 5,
                        226,
                        tick,
                        11
                    );
                }

                // X축
                const zeroY = yPx(0);

                svg.appendChild(el("line", {
                    x1: 38,
                    y1: zeroY,
                    x2: 322,
                    y2: zeroY,
                    stroke: "#64748b",
                    "stroke-width": 1.6
                }));

                // Y축
                svg.appendChild(el("line", {
                    x1: xPx(0),
                    y1: 19,
                    x2: xPx(0),
                    y2: 208,
                    stroke: "#64748b",
                    "stroke-width": 1.6
                }));

                // 함수 곡선
                const path = samples.map(
                    (p, i) =>

                        `${i ? "L" : "M"}` +
                        `${xPx(p.x).toFixed(1)},` +
                        `${yPx(p.y).toFixed(1)}`

                ).join(" ");

                svg.appendChild(el("path", {
                    d: path,
                    fill: "none",
                    stroke: "#2563eb",
                    "stroke-width": 2.4
                }));

                textAt(
                    svg,
                    5,
                    15,
                    "y",
                    12
                );

                textAt(
                    svg,
                    323,
                    225,
                    "x",
                    12
                );

                subtitle(
                    svg,
                    "함수식 기준 · x = -4 ~ 4 범위"
                );

                box.appendChild(svg);
                return;
            }
        }
    }


    // =====================================
    // 3. 원 SVG
    // =====================================

    const circleMatch = source.match(
        /(?:원\s*([A-Z])\b|중심(?:이|은|을)?\s*([A-Z])\b|반지름)/i
    );

    if (
        circleMatch &&
        /(?:원|반지름)/.test(source)
    ) {

        const name = (
            circleMatch[1] ||
            circleMatch[2] ||
            "O"
        ).toUpperCase();

        const svg = svgBase(
            "원과 반지름의 개념도"
        );

        // 원 그리기
        svg.appendChild(el("circle", {
            cx: 170,
            cy: 120,
            r: 80,
            fill: "#eff6ff",
            stroke: "#2563eb",
            "stroke-width": 2.4
        }));

        // 중심점
        svg.appendChild(el("circle", {
            cx: 170,
            cy: 120,
            r: 3,
            fill: "#2563eb"
        }));

        // 반지름 선
        svg.appendChild(el("line", {
            x1: 170,
            y1: 120,
            x2: 250,
            y2: 120,
            stroke: "#2563eb",
            "stroke-width": 2
        }));

        // 중심 이름
        textAt(
            svg,
            151,
            116,
            name,
            17
        );

        // 반지름 표시
        textAt(
            svg,
            205,
            111,
            "r",
            15
        );

        subtitle(
            svg,
            "원의 개념도 · 실제 반지름은 문제 조건 참조"
        );

        box.appendChild(svg);
    }
}

// =====================================
// ScorePath 21-369
// 응용문제 수학 수식 렌더링
// =====================================

let scorePathMathJaxPromiseV01 = null;

// MathJax는 최초 1회만 불러온다.
function loadScorePathMathJaxV01() {

    if (window.MathJax?.typesetPromise) {
        return Promise.resolve(window.MathJax);
    }

    if (scorePathMathJaxPromiseV01) {
        return scorePathMathJaxPromiseV01;
    }

    window.MathJax = {
        tex: {
            inlineMath: [
                ["\\(", "\\)"]
            ],
            displayMath: [
                ["\\[", "\\]"]
            ]
        },

        options: {
            skipHtmlTags: [
                "script",
                "noscript",
                "style",
                "textarea",
                "pre",
                "code",
                "svg"
            ]
        },

        startup: {
            typeset: false
        }
    };

    scorePathMathJaxPromiseV01 =
        new Promise((resolve, reject) => {

            const script =
                document.createElement("script");

            script.src =
                "https://cdn.jsdelivr.net/npm/mathjax@4/tex-mml-chtml.js";

            script.async = true;

            script.onload = async () => {

                try {

                    await window.MathJax.startup.promise;

                    resolve(window.MathJax);

                } catch (error) {

                    reject(error);
                }
            };

            script.onerror = () => {
                reject(
                    new Error(
                        "수식 표시 라이브러리를 불러오지 못했습니다."
                    )
                );
            };

            document.head.appendChild(script);
        });

    return scorePathMathJaxPromiseV01;
}

// 수식 구분자가 없는 일부 독립된 수식 줄 보정
function normalizeScorePathMathV01(value) {

    const lines = String(value || "").split("\n");

    let insideDisplayMath = false;

    return lines.map(line => {

        const startsMath = line.includes("\\[");
        const endsMath = line.includes("\\]");

        const shouldWrap =
            !insideDisplayMath &&
            !startsMath &&
            !endsMath &&
            !line.includes("\\(") &&
            !line.includes("\\)") &&
            !/[가-힣]/.test(line) &&
            /\\(?:sin|cos|tan|frac|dfrac|sqrt|pi|lim)\b/.test(line);

        if (startsMath && !endsMath) {
            insideDisplayMath = true;
        }

        if (endsMath) {
            insideDisplayMath = false;
        }

        return shouldWrap
            ? "\\[" + line.trim() + "\\]"
            : line;

    }).join("\n");
}

// 응용문제 수식을 화면에 표시
async function renderScorePathAdvancedMathV01() {

    const box = $("advancedProblemBox");

    if (!box) {
        return;
    }

    // 화면이 갱신되었을 때 이전 렌더링 방지
    const version = box._scorePathMathVersion || 0;

    try {

        const mathJax =
            await loadScorePathMathJaxV01();

        if (
            !box.isConnected ||
            box._scorePathMathVersion !== version
        ) {
            return;
        }

        await mathJax.typesetPromise([box]);

    } catch (error) {

        console.warn(
            "ScorePath 수식 표시 실패:",
            error.message
        );
    }
}


// ScorePath 21-383: 중복 수식 함수 제거, 아래의 단일 구현 사용


// =====================================
// 기존 AI 분석 화면 함수
// =====================================

// =====================================
// ScorePath 21-382
// 기본 분석 수학 수식 표시
// =====================================

function formatScorePathAnalysisMathV01(value) {
    const source = String(value || "");

    // 이미 MathJax 형식인 수식은 유지
    return source
        .split(/(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g)
        .map((part, index) => {
            if (index % 2 === 1) return part;

            return part.replace(
                /(√\d+\/\d+|[A-Za-z]\w*\^(?:\d+|\{[^}]+\})|(?:\d+|[A-Za-z])\/\[[^\]]+\]|(?:\d+|[A-Za-z])\/\([^()]+\)|(?:\d+|[A-Za-z])\/(?:\d+|[A-Za-z])|√\d+)/g,
                (found) => {
                    let tex = found.replace(/−/g, "-");

                    tex = tex
                        .replace(
                            /√(\d+)\/(\d+)/g,
                            "\\frac{\\sqrt{$1}}{$2}"
                        )
                        .replace(
                            /(\d+|[A-Za-z])\/\[([^\]]+)\]/g,
                            "\\frac{$1}{$2}"
                        )
                        .replace(
                            /(\d+|[A-Za-z])\/\(([^()]+)\)/g,
                            "\\frac{$1}{$2}"
                        )
                        .replace(
                            /(\d+|[A-Za-z])\/(\d+|[A-Za-z])/g,
                            "\\frac{$1}{$2}"
                        )
                        .replace(
                            /√(\d+)/g,
                            "\\sqrt{$1}"
                        );

                    return "\\(" + tex + "\\)";
                }
            );
        })
        .join("");
}


// =====================================
// 핵심 풀이 MathJax 렌더링
// =====================================

async function renderScorePathAnalysisMathV01(box, rawText) {
    if (!box) return;

    const version = (box._analysisMathVersion || 0) + 1;

    box._analysisMathVersion = version;
    box.style.whiteSpace = "pre-wrap";
    box.style.lineHeight = "1.8";

    const formatted =
        formatScorePathAnalysisMathV01(rawText);

    // 이미 LaTeX 형식인 수식도 렌더링한다.
    const hasMathDelimiters =
        /\\\(|\\\[/.test(formatted);

    // 일반 텍스트에만 해당할 때 렌더링 생략
    if (
        formatted === rawText &&
        !hasMathDelimiters
    ) {
        return;
    }

    try {
        const mathJax = await loadScorePathMathJaxV01();

        if (
            !box.isConnected ||
            box._analysisMathVersion !== version
        ) {
            return;
        }

        mathJax.typesetClear?.([box]);

        box.textContent = formatted;

        await mathJax.typesetPromise([box]);

    } catch (error) {
        if (box._analysisMathVersion === version) {
            box.textContent = rawText;
        }

        console.warn(
            "기본 분석 수식 표시 실패:",
            error.message
        );
    }
}


// =====================================
// 기존 AI 분석 결과 함수
// =====================================

function renderCurrentAnalysis() {
    const state = currentAnalysisState || {};

    const verificationBox = $("verificationBox");
    const aiAnswerText = $("resultAiAnswer");
    const warningText = $("resultWarning");

    if (state.aiAnswer || state.warning) {
        verificationBox.hidden = false;
        aiAnswerText.textContent = state.aiAnswer || "확인 어려움";

        warningText.textContent = state.warning || "";

        if (state.verification === "mismatch") {
            warningText.style.color = "red";
        } else if (state.verification === "uncertain") {
            warningText.style.color = "orange";
        } else {
            warningText.style.color = "green";
        }
    } else {
        verificationBox.hidden = true;
        aiAnswerText.textContent = "";
        warningText.textContent = "";
    }

    // 화면에는 두 영역만 표시. 기존 분석 상세 데이터는 서버에 보존한다.
    const mainResult = $("resultReason");
    const studyResult = $("resultConcept");
    const oldSolution = $("resultSolution");

    // =====================================
    // ScorePath 21-382
    // 기본 AI 분석 수식 렌더링
    // =====================================

    const solutionText =
        state.solution ||
        "아직 분석 결과가 없습니다.";

    // 이전 수식 표시 정보 정리
    window.MathJax?.typesetClear?.([
        mainResult
    ]);

    // 기본 텍스트 먼저 표시
    mainResult.textContent =
        solutionText;

    // 수학 수식 렌더링
    // 추가 AI 호출 없음
    void renderScorePathAnalysisMathV01(
        mainResult,
        solutionText
    );

    const studyWords = [
        state.weakConcept || state.concept || "",
        state.weakConceptDetail || ""
    ].filter(Boolean);
    studyResult.textContent =
        studyWords.join(" · ") || "아직 분석 결과가 없습니다.";

    // HTML의 기존 제목도 두 영역에 맞게 교체한다.
    const setCompactHeading = (element, title) => {
        const prev = element?.previousElementSibling;
        if (prev && prev.textContent.trim().length <= 40) {
            prev.textContent = title;
        }
    };
    setCompactHeading(mainResult, "핵심 풀이");
    setCompactHeading(studyResult, "다음 공부");
    oldSolution.textContent = "";
    oldSolution.hidden = true;
    oldSolution.style.display = "none";
    const oldTitle = oldSolution.previousElementSibling;
    if (oldTitle && /해결 방법|풀이|방법/.test(oldTitle.textContent)) {
        oldTitle.hidden = true;
        oldTitle.style.display = "none";
    }

    // =====================================
    // ScorePath 21-369
    // 응용문제 텍스트 + 수식 + SVG
    // =====================================

    const advancedBox = $("advancedProblemBox");

    // 기존 수식 렌더링 정보 정리
    if (window.MathJax?.typesetClear) {

        window.MathJax.typesetClear([
            advancedBox
        ]);
    }

    advancedBox._scorePathMathVersion =
        (advancedBox._scorePathMathVersion || 0) + 1;

    const advancedText =
        state.advancedProblem ||
        "아직 응용문제가 없습니다.";

    // 수식 표시를 위한 텍스트 설정
    advancedBox.textContent =
        normalizeScorePathMathV01(
            advancedText
        );

    // 기존 SVG V2 그림 생성 유지
    if (
        typeof renderScorePathAdvancedSvgV02 === "function"
    ) {

        renderScorePathAdvancedSvgV02(
            state.advancedProblem
        );
    }

    // 실제 수학 수식으로 렌더링
    if (
        /\\(?:\[|\(|frac|dfrac|sqrt|sin|cos|lim|begin)/.test(
            advancedText
        )
    ) {

        renderScorePathAdvancedMathV01();
    }

    // ScorePath 21-368
    // 응용문제 SVG 자동 생성
    renderScorePathAdvancedSvgV02(
        state.advancedProblem
    );

    // ScorePath 21-368
    // 응용문제 SVG 자동 생성 V2
    renderScorePathAdvancedSvgV02(
        state.advancedProblem
    );

    // ScorePath 21-367
    // 응용문제에 필요한 SVG 그림 자동 표시
    renderScorePathAdvancedSvgV01(
        state.advancedProblem
    );

    renderSimilarProblems(state.similarProblems || []);
    updateUpsellTexts(state.similarProblems || []);
}

function updateUpsellTexts(similarProblems = []) {
    if (!dashboardState) return;

    const plan = dashboardState.user.plan;
    const hasAnalysis = !!currentAnalysisState;
    const hasSimilarProblems =
        Array.isArray(similarProblems) && similarProblems.length > 0;

    // 분석 결과 자체가 없으면 업셀 문구도 전부 제거
    if (!hasAnalysis) {
        $("analysisUpsellText").textContent = "";
        $("similarUpsellText").textContent = "";
        return;
    }

    if (plan === "free") {
        $("analysisUpsellText").textContent =
            "유료 플랜에서는 유사문제 개수와 복습 기능이 더 늘어납니다.";

        $("similarUpsellText").textContent =
            hasSimilarProblems
                ? "9,900원 유료 플랜에서는 유사문제 2개와 응용문제를 제공합니다."
                : "";

    } else if (plan === "premium5900") {
        $("analysisUpsellText").textContent = "";

        $("similarUpsellText").textContent =
            hasSimilarProblems
                ? "9,900원 유료 플랜에서 응용문제를 이용할 수 있습니다."
                : "";

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

   const text =
    typeof problem === "string"
        ? problem
        : (
            problem.problem ||
            problem.question ||
            problem.text ||
            problem.content ||
            problem.prompt ||
            ""
        );

    div.innerHTML = `
        <div class="problem-item-title">유사문제 ${index + 1}</div>
        <div class="problem-item-text">${escapeHtml(text)}</div>
        <div class="button-row">
            <button type="button" class="secondary-btn" data-index="${index}">
                이 문제 풀기
            </button>
        </div>
    `;

    box.appendChild(div);
    // 기본 분석에 사용 중인 수식 표시 도구를 재사용한다 (추가 AI 비용 없음).
    const mathElement = div.querySelector(".problem-item-text");
    if (mathElement) void renderScorePathAnalysisMathV01(mathElement, text);
});

    box.querySelectorAll("[data-index]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const idx = Number(btn.dataset.index);
            const chosen = currentAnalysisState?.similarProblems?.[idx];
            if (!chosen) return;

            // 이전 문제 사진 제거
            // 유사문제는 새로운 텍스트 문제로 시작
            removeSelectedProblemImage();

     $("problem").value =
    typeof chosen === "string"
        ? chosen
        : (
            chosen.problem ||
            chosen.question ||
            chosen.text ||
            chosen.content ||
            chosen.prompt ||
            ""
        );
            $("userAnswer").value = "";
$("correctAnswer").value = "";

activeModeState = {
    type: "similar",
    sourceIndex: idx,
    generatedProblemId: chosen.id || ""
};

// 이전 문제의 분석 결과 제거
currentAnalysisState = null;

renderCurrentAnalysis();
updateModeUI();

showMessage(
    "유사문제를 불러왔습니다. 정답을 직접 입력하고 채점하세요.",
    "blue"
);

$("problem").focus();
        });
    });

     // 유사문제는 "이 문제 풀기" 버튼으로 이동
    // 답을 모르면 기존 "AI 분석하기" 버튼을 사용
}

function updatePlanLocks() {

    if (!dashboardState) return;

    const rule = dashboardState.planRule;

    $("cardSummary").hidden =
        !rule.reviewEnabled;

    $("cardSubjectStats").hidden =
        !rule.reviewEnabled;

    // =====================================
    // 노트는 요금제와 관계없이 확인 가능
    // =====================================

    $("cardSolved").hidden = false;

    $("cardAdvanced").hidden =
        !rule.advancedEnabled;
}

// =====================================
// ScorePath 21-343
// 오답 / 맞힌 문제 공통 검색 필터
// =====================================

function filterSavedNotesV01(items, listType = "wrong") {

    if (!dashboardState) return [];

    const activeSubjects =
        dashboardState?.user?.subjects || [];

    // 오답 검색과 맞힌 문제 검색을 서로 독립적으로 유지한다.
    const isSolved = listType === "solved";
    const filterSubject =
        $(isSolved ? "solvedFilterSubject" : "filterSubject")?.value || "전체";

    const search =
        ($(isSolved ? "solvedSearchInput" : "searchInput")?.value || "")
            .trim()
            .toLowerCase();

    const sortType =
        $(isSolved ? "solvedSortType" : "sortType")?.value || "latest";

    const typeQueries = {
        "기본": "normal",
        "기본문제": "normal",
        "유사": "similar",
        "유사문제": "similar",
        "응용": "advanced",
        "응용문제": "advanced"
    };

    const filtered = (
        Array.isArray(items) ? items : []
    ).filter(note => {

        // 등록된 과목만 표시
        if (
            !activeSubjects.includes(note.subject)
        ) {
            return false;
        }

        // 과목 필터
        if (
            filterSubject !== "전체" &&
            note.subject !== filterSubject
        ) {
            return false;
        }

        if (!search) return true;

        const sourceType =
            note.sourceType || "normal";

        // 기본 / 유사 / 응용문제 검색
        if (
            Object.prototype.hasOwnProperty.call(
                typeQueries,
                search
            )
        ) {
            return sourceType === typeQueries[search];
        }

        const typeLabel =
            sourceType === "similar"
                ? "유사문제"
                : sourceType === "advanced"
                    ? "응용문제"
                    : "기본문제";

        // 오답과 맞힌 문제 모두 같은 기준 사용
        return [
            typeLabel,
            note.subject,
            note.unit,
            note.problem,
            note.userAnswer,
            note.correctAnswer,
            note.reason,
            note.concept,
            note.solution,
            note.weakConcept,
            note.errorType,
            note.errorDetail
        ].some(value =>

            String(value ?? "")
                .toLowerCase()
                .includes(search)
        );
    });

    // 기존 정렬 기능 유지
    const eventTime = note =>
        Number(
            note.solvedAt ||
            note.updatedAt ||
            note.createdAt ||
            0
        );

    filtered.sort((a, b) =>

        sortType === "oldest"

            ? eventTime(a) - eventTime(b)

            : eventTime(b) - eventTime(a)
    );

    return filtered;
}


// =====================================
// 기존 오답 검색 함수 유지
// =====================================

function getFilteredAndSortedWrongNotes() {

    return filterSavedNotesV01(
        dashboardState?.wrongNotes || [],
        "wrong"
    );
}

function getFilteredAndSortedSolvedNotes() {
    return filterSavedNotesV01(
        dashboardState?.solvedNotes || [],
        "solved"
    );
}

function renderWrongList() {
    const list = $("wrongList");
    const notes =
        getFilteredAndSortedWrongNotes();

    list.innerHTML = "";

    if (notes.length === 0) {
        list.innerHTML =
            "<li>조건에 맞는 오답이 없습니다.</li>";
        return;
    }

    notes.forEach((note) => {
        const typeLabel =
            note.sourceType === "similar"
                ? "유사문제"
                : note.sourceType === "advanced"
                ? "응용문제"
                : "기본 문제";

        const problemView =
            note.problemImageKey
                ? `
                    <div>
                        <strong>문제:</strong>
                    </div>

                    <img
                        src="/api/problem-image?key=${encodeURIComponent(
                            note.problemImageKey
                        )}"
                        alt="문제 사진"
                        loading="lazy"
                        style="
                            display:block;
                            max-width:100%;
                            max-height:500px;
                            object-fit:contain;
                            margin-top:8px;
                            border-radius:8px;
                        "
                    >
                `
                : `
                    <div>
                        <strong>문제:</strong>
                        ${escapeHtml(
                            note.problem
                        )}
                    </div>
                `;

        const li =
            document.createElement(
                "li"
            );

        li.innerHTML = `
            <div><strong>구분:</strong> ${escapeHtml(typeLabel)}</div>
            <div><strong>과목:</strong> ${escapeHtml(note.subject)}</div>

            ${problemView}

            <div><strong>내 답:</strong> ${escapeHtml(note.userAnswer)}</div>
            <div><strong>정답:</strong> ${escapeHtml(note.correctAnswer)}</div>
            <div><strong>틀린 이유:</strong> ${escapeHtml(note.reason || "-")}</div>
            <div><strong>부족한 개념:</strong> ${escapeHtml(note.concept || "-")}</div>
            <div><strong>해결 방법:</strong> ${escapeHtml(note.solution || "-")}</div>
            <div><strong>반복 횟수:</strong> ${note.repeatWrongCount || 1}</div>

            <div class="item-buttons">
                <button
                    type="button"
                    data-retry="${note.id}"
                >
                    다시풀기
                </button>

                <button
                    type="button"
                    class="delete-item-btn"
                    data-delete="${note.id}"
                >
                    삭제
                </button>
            </div>
        `;

        list.appendChild(li);
    });

    list
        .querySelectorAll(
            "[data-retry]"
        )
        .forEach((btn) => {
            btn.addEventListener(
                "click",
                () =>
                    retryWrongNote(
                        btn.dataset.retry
                    )
            );
        });

    list
        .querySelectorAll(
            "[data-delete]"
        )
        .forEach((btn) => {
            btn.addEventListener(
                "click",
                () =>
                    deleteWrongNote(
                        btn.dataset.delete
                    )
            );
        });
}

function renderSolvedList() {
    const list =
        $("solvedList");

    // =====================================
    // ScorePath 21-344
    // 맞힌 문제에도 동일한 검색 적용
    // =====================================

    const notes =
        getFilteredAndSortedSolvedNotes();

    list.innerHTML = "";

    if (notes.length === 0) {

        const searching = Boolean(

            $("solvedSearchInput")?.value?.trim() ||

            (
                $("solvedFilterSubject")?.value ||
                "전체"
            ) !== "전체"
        );

        list.innerHTML = searching

            ? "<li>검색 조건에 맞는 맞힌 문제가 없습니다.</li>"

            : "<li>복습 완료된 문제가 없습니다.</li>";

        return;
    }

    notes.forEach((note) => {
        const typeLabel =
            note.sourceType === "similar"
                ? "유사문제"
                : note.sourceType === "advanced"
                ? "응용문제"
                : "기본 문제";

        const problemView =
            note.problemImageKey
                ? `
                    <div>
                        <strong>문제:</strong>
                    </div>

                    <img
                        src="/api/problem-image?key=${encodeURIComponent(
                            note.problemImageKey
                        )}"
                        alt="문제 사진"
                        loading="lazy"
                        style="
                            display:block;
                            max-width:100%;
                            max-height:500px;
                            object-fit:contain;
                            margin-top:8px;
                            border-radius:8px;
                        "
                    >
                `
                : `
                    <div>
                        <strong>문제:</strong>
                        ${escapeHtml(
                            note.problem
                        )}
                    </div>
                `;

        const li =
            document.createElement(
                "li"
            );

        li.innerHTML = `
            <div><strong>구분:</strong> ${escapeHtml(typeLabel)}</div>
            <div><strong>과목:</strong> ${escapeHtml(note.subject)}</div>

            ${problemView}

            <div><strong>내 답:</strong> ${escapeHtml(note.userAnswer)}</div>
            <div><strong>정답:</strong> ${escapeHtml(note.correctAnswer)}</div>

            <div class="item-buttons">
                <button
                    type="button"
                    data-restore="${note.id}"
                >
                    오답으로 복원
                </button>

                <button
                    type="button"
                    class="delete-item-btn"
                    data-delete-solved="${note.id}"
                >
                    삭제
                </button>
            </div>
        `;

        list.appendChild(li);
    });

    list
        .querySelectorAll(
            "[data-restore]"
        )
        .forEach((btn) => {
            btn.addEventListener(
                "click",
                () =>
                    restoreSolvedNote(
                        btn.dataset.restore
                    )
            );
        });

    list
        .querySelectorAll(
            "[data-delete-solved]"
        )
        .forEach((btn) => {
            btn.addEventListener(
                "click",
                () =>
                    deleteSolvedNote(
                        btn.dataset
                            .deleteSolved
                    )
            );
        });
}

function renderTrashList() {
    const list = $("trashList");

    if (!list) return;

    const notes = [...(dashboardState?.trashNotes || [])]
        .sort(
            (a, b) =>
                (b.deletedAt || 0) -
                (a.deletedAt || 0)
        );

    list.innerHTML = "";

    if (notes.length === 0) {
        list.innerHTML = "<li>휴지통이 비어 있습니다.</li>";
        return;
    }

    notes.forEach((note) => {
        const typeLabel =
            note.sourceType === "similar"
                ? "유사문제"
                : note.sourceType === "advanced"
                ? "응용문제"
                : "기본 문제";

        const fromLabel =
            note.trashFrom === "solved"
                ? "복습완료"
                : "오답";

        const deletedDate =
            note.deletedAt
                ? new Date(note.deletedAt).toLocaleString()
                : "-";

        const problemView =
    note.problemImageKey
        ? `
            <div>
                <strong>문제:</strong>
            </div>

            <img
                src="/api/problem-image?key=${encodeURIComponent(
                    note.problemImageKey
                )}"
                alt="문제 사진"
                loading="lazy"
                style="
                    display:block;
                    max-width:100%;
                    max-height:500px;
                    object-fit:contain;
                    margin-top:8px;
                    border-radius:8px;
                "
            >
        `
        : `
            <div>
                <strong>문제:</strong>
                ${escapeHtml(note.problem)}
            </div>
        `;

const li = document.createElement("li");

li.innerHTML = `
    <div><strong>원래 위치:</strong> ${escapeHtml(fromLabel)}</div>
    <div><strong>구분:</strong> ${escapeHtml(typeLabel)}</div>
    <div><strong>과목:</strong> ${escapeHtml(note.subject)}</div>

    ${problemView}

    <div><strong>삭제일:</strong> ${escapeHtml(deletedDate)}</div>

            <div class="item-buttons">
                <button
                    type="button"
                    data-trash-restore="${note.id}">
                    복구
                </button>

                <button
                    type="button"
                    class="delete-item-btn"
                    data-trash-delete="${note.id}">
                    영구삭제
                </button>
            </div>
        `;

        list.appendChild(li);
    });

    list
        .querySelectorAll("[data-trash-restore]")
        .forEach((btn) => {
            btn.addEventListener("click", () => {
                restoreTrashNote(btn.dataset.trashRestore);
            });
        });

    list
        .querySelectorAll("[data-trash-delete]")
        .forEach((btn) => {
            btn.addEventListener("click", () => {
                permanentlyDeleteTrashNote(
                    btn.dataset.trashDelete
                );
            });
        });
}

function renderRecommendedReviews() {
    const box =
        $("recommendedReviewBox");

    const activeSubjects =
        dashboardState?.user?.subjects || [];

    const list =
        (
            dashboardState?.recommendedReviews ||
            []
        ).filter(
            (item) =>
                activeSubjects.includes(
                    item.subject
                )
        );

    box.innerHTML = "";

    if (list.length === 0) {
        box.innerHTML = `
            <div class="problem-item">
                <div class="problem-item-text">
                    오늘 예정된 복습이 없습니다.
                </div>
            </div>
        `;

        return;
    }

    list.forEach((item) => {
        const div =
            document.createElement("div");

        div.className = "problem-item";

        div.innerHTML = `
            <div class="problem-item-title">
                ${escapeHtml(item.subject)}
                / 복습 ${Number(item.stage || 1)}단계
            </div>

            <div class="problem-item-text">
                ${escapeHtml(
                    item.label ||
                    "복습할 약점"
                )}
            </div>

            <button
                type="button"
                class="small-btn"
                data-start-scheduled-review="${escapeHtml(
                    item.weaknessKey
                )}"
            >
                복습하기
            </button>
        `;

        box.appendChild(div);
    });

    box
        .querySelectorAll(
            "[data-start-scheduled-review]"
        )
        .forEach((button) => {
            button.addEventListener(
                "click",
                () => {
                    startScheduledReview(
                        button.dataset
                            .startScheduledReview
                    );
                }
            );
        });
}


async function startScheduledReview(
    weaknessKey
) {
    try {
        const data =
            await api(
                "/api/reviews/start",
                "POST",
                {
                    weaknessKey
                }
            );

        activeModeState = {
            type: "scheduled_review",

            reviewAttemptId:
                data.reviewAttemptId,

            weaknessKey:
                data.weaknessKey,

            stage:
                data.stage,

            label:
                data.label
        };

        currentAnalysisState = null;

        $("subject").value =
            data.subject;

        $("problem").value =
            data.problem;

        $("userAnswer").value = "";

        // 예약 복습 정답은 서버에만 저장
        $("correctAnswer").value = "";

        renderCurrentAnalysis();
        updateModeUI();

        showMessage(
            `${data.label} · ${data.stage}단계 복습입니다. 문제를 풀어보세요.`,
            "blue"
        );

        $("problem").scrollIntoView({
            behavior: "smooth",
            block: "center"
        });

        $("userAnswer").focus();

    } catch (error) {
        showMessage(
            error.message,
            "red"
        );
    }
}


// =====================================
// 6단계 - 약점 훈련 시작
// =====================================

async function startWeaknessTraining(
    weaknessKey
) {
    try {
        const data =
            await api(
                "/api/training/start",
                "POST",
                {
                    weaknessKey
                }
            );

        activeModeState = {
            type: "weakness_training",

            trainingAttemptId:
                data.trainingAttemptId,

            weaknessKey:
                data.weaknessKey,

            label:
                data.label
        };

        currentAnalysisState = null;

        $("subject").value =
            data.subject;

        $("problem").value =
            data.problem;

        $("userAnswer").value = "";

        // 약점 훈련 정답도 서버에만 저장
        $("correctAnswer").value = "";

        renderCurrentAnalysis();
        updateModeUI();

        showMessage(
            `${data.label} 약점 훈련입니다. 문제를 풀어보세요.`,
            "blue"
        );

        $("problem").scrollIntoView({
            behavior: "smooth",
            block: "center"
        });

        $("userAnswer").focus();

    } catch (error) {
        showMessage(
            error.message,
            "red"
        );
    }
}

function renderSummaryStats() {
    const activeSubjects = dashboardState?.user?.subjects || [];

    const wrongNotes = (dashboardState?.wrongNotes || []).filter(
        (note) => activeSubjects.includes(note.subject)
    );

    const solvedNotes = (dashboardState?.solvedNotes || []).filter(
        (note) => activeSubjects.includes(note.subject)
    );
    
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

   const subjects = dashboardState?.user?.subjects || [];

subjects.forEach((subject) => {
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

    if (["premium9900", "premium8900", "premium5900"].includes(plan)) {
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
    const activeSubjects = dashboardState?.user?.subjects || [];

    const wrongNotes = (dashboardState?.wrongNotes || []).filter(
        (note) => activeSubjects.includes(note.subject)
    );

    const solvedNotes = (dashboardState?.solvedNotes || []).filter(
        (note) => activeSubjects.includes(note.subject)
    );

    const filteredNotes = getFilteredAndSortedWrongNotes();

    $("wrongCount").textContent = `오답 개수: ${wrongNotes.length}`;
    $("solvedCount").textContent = `복습완료 개수: ${solvedNotes.length}`;
    $("filterCount").textContent =
        `현재 보기: ${$("filterSubject").value} / ${filteredNotes.length}개`;

    // 맞힌 문제 검색 결과와 전체 개수를 별도로 보여준다.
    const solvedFilterCount = $("solvedFilterCount");
    const solvedTotalCount = $("solvedTotalCount");
    if (solvedFilterCount) {
        solvedFilterCount.textContent =
            `현재 보기: ${$("solvedFilterSubject")?.value || "전체"} / ` +
            `${getFilteredAndSortedSolvedNotes().length}개`;
    }
    if (solvedTotalCount) {
        solvedTotalCount.textContent =
            `맞힌 문제 전체: ${solvedNotes.length}개`;
    }
}

function renderSubjects() {
    if (!dashboardState) return;

    const subjects =
        dashboardState.user?.subjects || [];

    const subjectSelect =
        $("subject");

    const filterSelect =
        $("filterSubject");

    const solvedFilterSelect =
        $("solvedFilterSubject");

    const examSubjectSelect =
        $("examSubject");


    const currentSubject =
        subjectSelect?.value || "";

    const currentFilter =
        filterSelect?.value || "전체";

    const currentSolvedFilter =
        solvedFilterSelect?.value || "전체";

    const currentExamSubject =
        examSubjectSelect?.value || "";


    // =====================================
    // 문제 입력 과목
    // =====================================

    if (subjectSelect) {
        subjectSelect.innerHTML = "";

        subjects.forEach((subject) => {
            const option =
                document.createElement("option");

            option.value = subject;
            option.textContent = subject;

            subjectSelect.appendChild(option);
        });


        if (
            subjects.includes(
                currentSubject
            )
        ) {
            subjectSelect.value =
                currentSubject;
        }
    }


    // =====================================
    // 오답 리스트 과목 필터
    // =====================================

    if (filterSelect) {
        filterSelect.innerHTML =
            `<option value="전체">전체</option>`;

        subjects.forEach((subject) => {
            const option =
                document.createElement("option");

            option.value = subject;
            option.textContent = subject;

            filterSelect.appendChild(option);
        });


        if (
            currentFilter === "전체" ||
            subjects.includes(
                currentFilter
            )
        ) {
            filterSelect.value =
                currentFilter || "전체";
        }
    }


    // =====================================
    // 맞힌 문제 별도 과목 필터
    // =====================================
    if (solvedFilterSelect) {
        solvedFilterSelect.innerHTML =
            `<option value="전체">전체</option>`;
        subjects.forEach((subject) => {
            const option = document.createElement("option");
            option.value = subject;
            option.textContent = subject;
            solvedFilterSelect.appendChild(option);
        });
        if (
            currentSolvedFilter === "전체" ||
            subjects.includes(currentSolvedFilter)
        ) {
            solvedFilterSelect.value = currentSolvedFilter || "전체";
        }
    }

    // =====================================
    // ScorePath 시험 등록 과목
    // =====================================

    if (examSubjectSelect) {
        examSubjectSelect.innerHTML =
            `<option value="">과목 선택</option>`;

        subjects.forEach((subject) => {
            const option =
                document.createElement("option");

            option.value = subject;
            option.textContent = subject;

            examSubjectSelect.appendChild(
                option
            );
        });


        if (
            subjects.includes(
                currentExamSubject
            )
        ) {
            examSubjectSelect.value =
                currentExamSubject;
        }
    }
}

// =====================================
// ScorePath 21-192
// 성장 화면 → 추천 공부 연결
// =====================================

async function openScorePathGrowthLearningV01(button) {

    if (button.disabled) return;

    const subject =
        button.dataset.scorepathGrowthSubject || "";

    const unit =
        button.dataset.scorepathGrowthUnit || "";

    const examId =
        button.dataset.scorepathGrowthExam || "";

    button.disabled = true;

    try {

        // 1. 등록된 시험 조회
        const data = await api("/api/exams");

        const exams = (
            Array.isArray(data.exams)
                ? data.exams
                : []
        ).filter((exam) => !exam.isPast);

        const sameSubject = (exam) =>
            !subject ||
            exam.subject === subject;

        const hasUnit = (exam) =>
            Array.isArray(exam.examRange) &&
            exam.examRange.includes(unit);

        // 2. 관련 시험 찾기
        const selected =

            exams.find((exam) =>
                String(exam.id) === examId &&
                sameSubject(exam) &&
                (!unit || hasUnit(exam))
            ) ||

            (unit
                ? exams.find((exam) =>
                    sameSubject(exam) &&
                    hasUnit(exam)
                )
                : null
            ) ||

            exams.find((exam) =>
                String(exam.id) === examId &&
                sameSubject(exam)
            ) ||

            exams.find(sameSubject);

        if (!selected) {

            setScorePathMainNavigationV01("exams");

            alert(
                "관련된 예정 시험이 없습니다. " +
                "시험부터 등록해 주세요."
            );

            return;
        }

        // 3. 기존 추천 전광판 열기
        const opened =
            await openExamRisk(selected.id);

        if (!opened) {
            throw new Error(
                "시험 전광판을 열지 못했습니다."
            );
        }

        // 단원 지정 없이 과목만 선택한 경우
        if (!unit) return;

        // 4. 오늘의 학습 계획 확인
        const sessions =
            Array.isArray(
                selected.dailyStudyPlan?.sessions
            )
                ? selected.dailyStudyPlan.sessions
                : [];

        const index =
            sessions.findIndex(
                (item) => item.unit === unit
            );

        // 오늘 추천되지 않은 단원
        if (index < 0) {

            alert(
                "이 단원은 오늘의 추천 목록에 없습니다. " +
                "전광판에서 학습 우선순위를 확인하세요."
            );

            return;
        }

        // 5. 기존 공부 시작 버튼 재활용
        const start =
            $("examRiskSummary")?.querySelector(
                `[data-study-start="${index}"]`
            );

        if (!start || start.disabled) {

            alert(
                "진행 중인 학습이 있거나 " +
                "시작할 수 없는 상태입니다. " +
                "전광판에서 확인하세요."
            );

            return;
        }

        start.click();

    } catch (error) {

        alert(
            error.message ||
            "추천 학습으로 이동하지 못했습니다."
        );

    } finally {

        button.disabled = false;
    }
}

// 성장 화면 버튼 연결
document.addEventListener("click", (event) => {

    const button = event.target.closest?.(
        "[data-scorepath-growth-action]"
    );

    if (button) {

        void openScorePathGrowthLearningV01(
            button
        );
    }
});


function renderTodayLearning() {
    const today =
        dashboardState?.todayLearning || {};

    const retryProblems =
        Array.isArray(today.retryProblems)
            ? today.retryProblems
            : [];

    const reviewConcepts =
        Array.isArray(today.reviewConcepts)
            ? today.reviewConcepts
            : [];

    const weaknessTraining =
        Array.isArray(today.weaknessTraining)
            ? today.weaknessTraining
            : [];

    const topWeakness =
        today.topWeakness || null;


    // =====================================
    // 상단 숫자
    // =====================================

    $("todayRetryCount").textContent =
        String(retryProblems.length);

    $("todayReviewCount").textContent =
        String(reviewConcepts.length);

    $("todayTrainingCount").textContent =
        String(weaknessTraining.length);

    // =====================================
    // ScorePath 21-187
    // 성장 화면: 실제 저장 기록 요약
    // =====================================

    const growthBox =
        $("scorePathGrowthSnapshotV01");

    if (growthBox) {

        const activeSubjects = new Set(
            dashboardState?.user?.subjects || []
        );

        const countActive = (items) =>
            (Array.isArray(items) ? items : [])
                .filter((item) =>
                    activeSubjects.has(item.subject)
                ).length;

        // =====================================
        // 현재 남아 있는 오답
        // =====================================

        const remainingWrong = countActive(
            dashboardState?.wrongNotes
        );

        // =====================================
        // 복습 완료 기록
        // =====================================

        const completedReview = countActive(
            dashboardState?.solvedNotes
        );

        // =====================================
        // 주요 약점
        // =====================================

        const focusLabel = topWeakness

            ? `${topWeakness.subject || "기타"} · ${
                topWeakness.label ||
                topWeakness.weakConcept ||
                "분류되지 않은 약점"
            }`

            : "아직 분석할 약점 기록이 없습니다.";

        // =====================================
        // 성장 현황 출력
        // =====================================

        growthBox.innerHTML = `

            <div class="scorepath-growth-metric">

                <span>
                    남아 있는 오답
                </span>

                <strong>
                    ${remainingWrong}개
                </strong>

            </div>

            <div class="scorepath-growth-metric">

                <span>
                    복습 완료 기록
                </span>

                <strong>
                    ${completedReview}개
                </strong>

            </div>

            <div class="scorepath-growth-focus">

                <span>
                    📌 기록에서 발견한 주요 약점
                </span>

                <strong>
                    ${escapeHtml(focusLabel)}
                </strong>

                <small>
                    저장된 오답·복습 기록 기준이며,
                    실력 향상이나 시험 점수의
                    예측값은 아닙니다.
                </small>

            </div>
        `;
    }

    // =====================================
    // 다시 풀어볼 문제
    // =====================================

    const retryBox =
        $("todayRetryProblems");

    retryBox.innerHTML = "";

    if (retryProblems.length === 0) {
        retryBox.innerHTML = `
            <div class="problem-item">
                <div class="problem-item-text">
                    지금 다시 풀어볼 오답이 없습니다.
                </div>
            </div>
        `;
    } else {
        retryProblems.forEach((item) => {
            const div =
                document.createElement("div");

            div.className = "problem-item";

            div.innerHTML = `
                <div class="problem-item-title">
                    ${escapeHtml(item.subject || "기타")}
                </div>

                <div class="problem-item-text">
                    ${escapeHtml(item.problem || "")}
                </div>

                <div class="check-text">
                    반복 오답 ${Number(
                        item.repeatWrongCount || 0
                    )}회
                    ${
                        item.weakConcept
                            ? ` · ${escapeHtml(
                                item.weakConcept
                            )}`
                            : ""
                    }
                </div>

                <div class="button-row">
                    <button
                        type="button"
                        class="secondary-btn"
                        data-today-retry="${escapeHtml(
                            item.noteId || ""
                        )}"
                    >
                        다시 풀기
                    </button>
                </div>
            `;

            retryBox.appendChild(div);
        });

        retryBox
            .querySelectorAll(
                "[data-today-retry]"
            )
            .forEach((button) => {
                button.addEventListener(
                    "click",
                    () => {
                        retryWrongNote(
                            button.dataset.todayRetry
                        );
                    }
                );
            });
    }


    // =====================================
    // 복습할 개념
    // =====================================

    const reviewBox =
        $("todayReviewConcepts");

    reviewBox.innerHTML = "";

    if (reviewConcepts.length === 0) {
        reviewBox.innerHTML = `
            <div class="problem-item">
                <div class="problem-item-text">
                    오늘 예정된 개념 복습이 없습니다.
                </div>
            </div>
        `;
    } else {
        reviewConcepts.forEach((item) => {
            const div =
                document.createElement("div");

            div.className = "problem-item";

            div.innerHTML = `
                <div class="problem-item-title">
                    ${escapeHtml(
                        item.subject || "기타"
                    )}
                    · ${Number(item.stage || 1)}단계
                </div>

                <div class="problem-item-text">
                    ${escapeHtml(
                        item.label ||
                        "복습할 개념"
                    )}
                </div>

                <div class="check-text">
                    약점 점수 ${Number(
                        item.weaknessScore || 0
                    )}
                </div>

                <div class="button-row">
                    <button
                        type="button"
                        class="secondary-btn"
                        data-today-review="${escapeHtml(
                            item.weaknessKey || ""
                        )}"
                    >
                        복습하기
                    </button>
                </div>
            `;

            reviewBox.appendChild(div);
        });

        reviewBox
            .querySelectorAll(
                "[data-today-review]"
            )
            .forEach((button) => {
                button.addEventListener(
                    "click",
                    () => {
                        startScheduledReview(
                            button.dataset.todayReview
                        );
                    }
                );
            });
    }


    // =====================================
    // 약점 훈련
    // =====================================

    const trainingBox =
        $("todayWeaknessTraining");

    trainingBox.innerHTML = "";

    if (weaknessTraining.length === 0) {
        trainingBox.innerHTML = `
            <div class="problem-item">
                <div class="problem-item-text">
                    현재 집중 훈련이 필요한 약점이 없습니다.
                </div>
            </div>
        `;
    } else {
        weaknessTraining.forEach(
            (item, index) => {
                const div =
                    document.createElement("div");

                div.className = "problem-item";

                div.innerHTML = `
                    <div class="problem-item-title">
                        ${index + 1}.
                        ${escapeHtml(
                            item.subject || "기타"
                        )}
                    </div>

                    <div class="problem-item-text">
                        ${escapeHtml(
                            item.label ||
                            item.weakConcept ||
                            "분류되지 않은 약점"
                        )}
                    </div>

                    <div class="check-text">
                        약점 점수
                        ${Number(
                            item.weaknessScore || 0
                        )}
                        · 오답
                        ${Number(
                            item.wrongCount || 0
                        )}회
                    </div>

                    <div class="button-row">
                        <button
                            type="button"
                            class="secondary-btn"
                            data-start-weakness-training="${escapeHtml(
                                item.weaknessKey || ""
                            )}"
                        >
                            훈련하기
                        </button>
                    </div>
                `;

                trainingBox.appendChild(div);
            }
        );

        trainingBox
            .querySelectorAll(
                "[data-start-weakness-training]"
            )
            .forEach((button) => {
                button.addEventListener(
                    "click",
                    () => {
                        startWeaknessTraining(
                            button.dataset
                                .startWeaknessTraining
                        );
                    }
                );
            });
    }


    // =====================================
    // 가장 많이 틀린 약점
    // =====================================

    const topBox =
        $("todayTopWeakness");

    if (!topWeakness) {
        topBox.innerHTML =
            "아직 약점 데이터가 없습니다.";
    } else {
        topBox.innerHTML = `
            <strong>
                ${escapeHtml(
                    topWeakness.subject || "기타"
                )}
                ·
                ${escapeHtml(
                    topWeakness.label ||
                    topWeakness.weakConcept ||
                    "분류되지 않은 약점"
                )}
            </strong>

            <div class="check-text">
                총 오답
                ${Number(
                    topWeakness.wrongCount || 0
                )}회
                · 약점 점수
                ${Number(
                    topWeakness.weaknessScore || 0
                )}
            </div>

            <!-- ScorePath 21-193 -->

            <div
                class="button-row"
                style="margin-top:12px;"
            >

                <button
                    type="button"
                    class="secondary-btn"
                    data-scorepath-growth-action
                    data-scorepath-growth-subject="${escapeHtml(
                        topWeakness.subject || ""
                    )}"
                >
                    📚 이 과목의 추천 공부 보기
                </button>

            </div>
        `;
    }
}


// =====================================
// ScorePath 21-117
// 앱 전체 메인 내비게이션 V0.1
// =====================================

let scorePathLastExamV01 = null;


// =====================================
// ScorePath 21-268
// 홈에서 남아 있는 시험 공부 확인 / 취소
// =====================================

let scorePathPendingExamRequestV01 = 0;

async function refreshScorePathPendingExamNoticeV01() {

    const home = $("cardInput");

    if (
        !home ||
        !dashboardState ||
        $("appShell")?.hidden
    ) {
        return;
    }

    const account = String(
        dashboardState.user?.id ||
        dashboardState.user?.email ||
        ""
    );

    const requestId =
        ++scorePathPendingExamRequestV01;

    let notice =
        $("scorePathPendingExamNoticeV01");

    // 다른 계정의 안내가 남아 있으면 제거
    if (
        notice &&
        notice.dataset.account !== account
    ) {
        notice.remove();
        notice = null;
    }

    try {

        // =====================================
        // 1. 서버에서 진행 중인 시험 공부 확인
        // =====================================

        const data = await api(
            "/api/scorepath/study/active"
        );

        // 계정 변경 또는 오래된 요청 보호
        if (
            requestId !==
                scorePathPendingExamRequestV01 ||

            $("appShell")?.hidden ||

            account !== String(
                dashboardState?.user?.id ||
                dashboardState?.user?.email ||
                ""
            )
        ) {
            return;
        }

        // =====================================
        // 2. 진행 중인 공부가 없다면 안내 제거
        // =====================================

        if (
            data.active !== true ||
            !data.session
        ) {

            notice?.remove();

            return;
        }

        const session = data.session;

        // =====================================
        // 3. 안내창 생성
        // =====================================

        if (!notice) {

            notice =
                document.createElement("section");

            notice.id =
                "scorePathPendingExamNoticeV01";

            notice.style.cssText =
                "padding:14px;" +
                "margin:12px 0;" +
                "border:1px solid #f59e0b;" +
                "border-radius:12px;" +
                "background:#fffbeb;";

            home.prepend(notice);
        }

        notice.dataset.account = account;

        const description =
            document.createElement("p");

        description.textContent =
            `⚠️ 이전 시험 공부 진행 중: ${
                session.unit || "단원 미지정"
            }. 일반 공부를 시작하려면 아래에서 취소하세요.`;

        // =====================================
        // 4. 취소 버튼 생성
        // =====================================

        const cancelButton =
            document.createElement("button");

        cancelButton.type = "button";

        cancelButton.className =
            "secondary-btn";

        cancelButton.textContent =
            "이전 시험 공부 취소";

        notice.replaceChildren(
            description,
            cancelButton
        );

        // =====================================
        // 5. 학습 취소 처리
        // =====================================

        cancelButton.onclick = async () => {

            const confirmed = confirm(
                `시험 공부 '${
                    session.unit || "단원 미지정"
                }'를 취소할까요?\n` +

                "완료 기록에는 포함되지 않지만 " +
                "기존 문제풀이 기록은 보존됩니다."
            );

            if (!confirmed) return;

            cancelButton.disabled = true;

            try {

                // 기존 서버 취소 API 재사용
                await api(
                    "/api/scorepath/study/cancel",
                    "POST",
                    {
                        sessionId: session.id
                    }
                );

                // =====================================
                // 오래된 시험 공부 완료 버튼 제거
                // =====================================

                $("scorePathStudyCompleteV01")
                    ?.remove();

                showMessage(
                    "이전 시험 공부를 취소했습니다. " +
                    "이제 일반 공부를 시작할 수 있습니다.",
                    "green"
                );

                // =====================================
                // 6. 서버 상태 다시 확인
                // =====================================

                await refreshScorePathPendingExamNoticeV01();

            } catch (error) {

                cancelButton.disabled = false;

                showMessage(
                    error.message ||
                    "시험 공부 취소에 실패했습니다.",
                    "red"
                );
            }
        };

    } catch (error) {

        if (
            requestId !==
            scorePathPendingExamRequestV01
        ) {
            return;
        }

        console.warn(
            "진행 중인 시험 공부 확인 실패:",
            error
        );

        if (!notice) {

            notice =
                document.createElement("section");

            notice.id =
                "scorePathPendingExamNoticeV01";

            notice.dataset.account = account;

            notice.style.cssText =
                "padding:12px;" +
                "margin:12px 0;" +
                "border:1px solid #f59e0b;" +
                "border-radius:12px;" +
                "background:#fffbeb;";

            home.prepend(notice);
        }

        notice.textContent =
            "시험 공부 진행 상태를 확인하지 못했습니다. " +
            "새로고침 후 다시 시도해주세요.";
    }
}


// =====================================
// ScorePath V1
// 시험 모드 ON/OFF
// =====================================

function setupScorePathExamModeSwitchV01() {

    const home = $("cardInput");

    if (!home || !dashboardState) return;

    let switchBox =
        $("scorePathExamModeSwitchV01");

    // =====================================
    // 스위치 최초 생성
    // =====================================

    if (!switchBox) {

        switchBox =
            document.createElement("div");

        switchBox.id =
            "scorePathExamModeSwitchV01";

        switchBox.style.cssText =
            "display:flex;" +
            "align-items:center;" +
            "justify-content:space-between;" +
            "gap:12px;" +
            "flex-wrap:wrap;" +
            "padding:12px 16px;" +
            "margin-bottom:14px;" +
            "border:1px solid #dbeafe;" +
            "border-radius:14px;" +
            "background:#f8fafc;";

        switchBox.innerHTML = `

            <div>

                <strong>
                    🎯 학습 모드
                </strong>

                <div
                    data-exam-mode-status
                    style="
                        font-size:13px;
                        color:#64748b;
                        margin-top:4px;
                    "
                ></div>

            </div>

            <button
                type="button"
                class="secondary-btn"
                data-exam-mode-toggle
            ></button>

        `;

        // 홈 상단에 배치
        home.prepend(switchBox);

        // =====================================
        // ON/OFF 버튼
        // =====================================

        const button =
            switchBox.querySelector(
                "[data-exam-mode-toggle]"
            );

        button.addEventListener(
            "click",
            async () => {

                if (button.disabled) return;

                button.disabled = true;

                try {

                    const examModeOn =
                        Boolean(
                            selectedExamState?.examId
                        );

                    // =====================================
                    // 시험 모드 OFF
                    // =====================================

                    if (examModeOn) {

                        selectedExamState = null;

                        // 문제풀이의 시험 연결도 해제
                        const examSelect =
                            $("scorePathExam");

                        if (examSelect) {

                            examSelect.value = "";

                            examSelect.dispatchEvent(
                                new Event("change")
                            );
                        }

                        // 무료 일반 전광판 갱신
                        if (
                            typeof renderScorePathGeneralBoardV01
                                === "function"
                        ) {
                            renderScorePathGeneralBoardV01();
                        }

                        setScorePathMainNavigationV01(
                            "home"
                        );

                        return;
                    }

                    // =====================================
                    // 시험 모드 ON
                    // =====================================

                    const account =
                        dashboardState?.user?.id ||
                        dashboardState?.user?.email ||
                        "";

                    const savedExam =
                        scorePathLastExamV01;

                    const examId =
                        savedExam?.account === account
                            ? String(
                                savedExam.examId || ""
                            )
                            : "";

                    // 선택한 시험이 없다면
                    // 시험 관리 화면으로 이동
                    if (!examId) {

                        await loadExamList();

                        setScorePathMainNavigationV01(
                            "exams"
                        );

                        alert(
                            "시험 모드를 켜려면 " +
                            "시험 목록에서 시험 대비 분석을 " +
                            "선택해 주세요."
                        );

                        return;
                    }

                    // 기존 시험 전광판 재사용
                    const opened =
                        await openExamRisk(examId);

                    if (!opened) {

                        alert(
                            "시험 전광판을 열지 못했습니다."
                        );

                        return;
                    }

                    setScorePathMainNavigationV01(
                        "home"
                    );

                } catch (error) {

                    console.error(
                        "시험 모드 전환 오류:",
                        error
                    );

                    alert(
                        error.message ||
                        "시험 모드를 변경하지 못했습니다."
                    );

                } finally {

                    button.disabled = false;
                }
            }
        );
    }

    // =====================================
    // 현재 상태 표시
    // =====================================

    const examModeOn =
        Boolean(
            selectedExamState?.examId
        );

    const status =
        switchBox.querySelector(
            "[data-exam-mode-status]"
        );

    const button =
        switchBox.querySelector(
            "[data-exam-mode-toggle]"
        );

    if (status) {

        status.textContent =
            examModeOn
                ? "시험 목표에 맞춘 학습 추천"
                : "일반 학습 추천";
    }

    if (button) {

        button.textContent =
            examModeOn
                ? "🔵 시험 모드 끄기"
                : "⚪ 시험 모드 켜기";

        button.setAttribute(
            "aria-pressed",
            String(examModeOn)
        );
    }

    // =====================================
    // ScorePath 21-269
    // 이전 시험 공부 자동 확인
    // =====================================

    // 시험 관리 화면에 직접 들어가지 않아도
    // 진행 중인 시험 공부를 확인한다.

    // 시험 공부가 남아 있다면
    // 일반 화면에 취소 버튼을 표시한다.

    void refreshScorePathPendingExamNoticeV01();
}

// =====================================
// 현재 선택한 메뉴 표시
// =====================================

// ==============================================
// ScorePath V1 | 요금제 / 개인정보·설정 화면
// 기존 요금제 테스트 버튼과 서버 결제 로직은 변경하지 않는다.
// ==============================================
function scorePathEnsureMemberHubV01() {
    const shell = $("appShell");
    if (!shell) return;

    if (!$("scorePathMemberHubStyleV01")) {
        const style = document.createElement("style");
        style.id = "scorePathMemberHubStyleV01";
        style.textContent = `
            #scorePathMainNavigationV01 [data-main-tab] { min-width:0 !important; padding:10px 4px !important; font-size:12px !important; }
            #cardScorePathMemberHubV01 { max-width:100%; box-sizing:border-box; }
            #cardScorePathMemberHubV01 .sp-hub-intro { color:#475569; margin:6px 0 16px; line-height:1.65; }
            #cardScorePathMemberHubV01 .sp-hub-tabs { display:flex; gap:8px; flex-wrap:wrap; margin:16px 0; }
            #cardScorePathMemberHubV01 .sp-hub-tabs button { flex:1 1 130px; cursor:pointer; padding:12px 8px; border-radius:12px; border:1px solid #cbd5e1; background:#fff; font-weight:700; color:#334155; }
            #cardScorePathMemberHubV01 .sp-hub-tabs button[aria-selected="true"] { color:#fff; background:#2563eb; border-color:#2563eb; }
            #cardScorePathMemberHubV01 .sp-plan-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,235px),1fr)); gap:12px; margin:14px 0; }
            #cardScorePathMemberHubV01 .sp-plan-card { border:1px solid #cbd5e1; border-radius:14px; padding:16px; background:#f8fafc; }
            #cardScorePathMemberHubV01 .sp-plan-card.sp-pro { border:2px solid #60a5fa; background:#eff6ff; }
            #cardScorePathMemberHubV01 .sp-plan-price { font-size:23px; font-weight:800; color:#1e40af; margin:7px 0; }
            #cardScorePathMemberHubV01 .sp-plan-card ul { padding-left:20px; line-height:1.9; margin:10px 0; }
            #cardScorePathMemberHubV01 .sp-note { border-radius:10px; background:#f1f5f9; border:1px solid #cbd5e1; padding:12px; line-height:1.65; color:#334155; margin:12px 0; }
            #cardScorePathMemberHubV01 .sp-settings-row { display:grid; grid-template-columns:minmax(92px,1fr) minmax(0,2fr); gap:12px; padding:11px 0; border-bottom:1px solid #e2e8f0; }
            #cardScorePathMemberHubV01 .sp-settings-row strong { color:#334155; }
            #cardScorePathMemberHubV01 .sp-settings-row span { word-break:break-word; overflow-wrap:anywhere; }
            #cardScorePathMemberHubV01 .sp-privacy-box { padding:14px; border:1px solid #e2e8f0; border-radius:12px; margin:12px 0; background:#fff; line-height:1.75; }
            #cardScorePathMemberHubV01 .sp-privacy-box h4 { margin:0 0 6px; }
            #cardScorePathMemberHubV01 .sp-privacy-box p { margin:0; }
            #cardScorePathMemberHubV01 button.sp-hub-logout { color:#334155 !important; min-width:95px; padding:11px 16px; border:1px solid #94a3b8; border-radius:10px; background:#fff; cursor:pointer; font-weight:700; }
            #cardScorePathMemberHubV01 button[disabled] { opacity:.65; cursor:not-allowed; }
            @media(max-width:420px) { #cardScorePathMemberHubV01 .sp-settings-row { grid-template-columns:1fr; gap:3px; } }
        `;
        document.head.appendChild(style);
    }

    let hub = $("cardScorePathMemberHubV01");
    if (!hub) {
        hub = document.createElement("section");
        hub.id = "cardScorePathMemberHubV01";
        hub.className = "card";
        hub.style.display = "none";
        hub.innerHTML = `
            <h2>👤 내 정보</h2>
            <p class="sp-hub-intro">요금제와 개인정보·계정 설정을 확인하세요.</p>
            <div class="sp-hub-tabs" role="tablist" aria-label="내 정보 화면">
                <button type="button" role="tab" data-sp-hub-tab="pricing" aria-controls="spHubPricingV01">💳 요금제 안내</button>
                <button type="button" role="tab" data-sp-hub-tab="privacy" aria-controls="spHubPrivacyV01">🔐 개인정보·설정</button>
            </div>
            <div id="spHubPricingV01" role="tabpanel" data-sp-hub-section="pricing">
                <p class="sp-note">현재 요금제: <strong data-sp-current-plan>확인 중</strong></p>
                <div class="sp-plan-grid">
                    <section class="sp-plan-card" aria-label="무료 요금제">
                        <h3>무료</h3><p class="sp-plan-price">0원</p>
                        <ul>
                            <li>AI 기본 분석: 하루 2회</li>
                            <li>유사문제: 분석당 1개</li>
                            <li>문제 저장: 최대 50개 (정답 + 오답)</li>
                            <li>응용문제 생성: 이용 불가</li>
                            <li>일반 학습 전광판: 무료 이용</li>
                        </ul>
                    </section>
                    <section class="sp-plan-card sp-pro" aria-label="유료 요금제">
                        <h3>ScorePath 유료</h3><p class="sp-plan-price">월 9,900원</p>
                        <ul>
                            <li>AI 기본 분석: 하루 15회</li>
                            <li>유사문제: 분석당 2개</li>
                            <li>응용문제 생성: 하루 2회</li>
                            <li>문제 저장: 무제한 (정답 + 오답)</li>
                            <li>복습 기능 이용 가능</li>
                        </ul>
                    </section>
                </div>
                <p class="sp-note">⚠️ 현재 결제 연동 준비 중입니다. 이 화면에서 결제나 구독 변경은 할 수 없습니다. 실제 결제·자동 갱신·해지 조건은 출시 전에 공지합니다.</p>
                <button type="button" disabled aria-disabled="true">결제 준비 중</button>
            </div>
            <div id="spHubPrivacyV01" role="tabpanel" data-sp-hub-section="privacy" hidden>
                <h3>계정 설정</h3>
                <div class="sp-settings-row"><strong>이름</strong><span data-sp-profile-name>—</span></div>
                <div class="sp-settings-row"><strong>이메일</strong><span data-sp-profile-email>—</span></div>
                <div class="sp-settings-row"><strong>현재 요금제</strong><span data-sp-profile-plan>—</span></div>
                <div class="sp-settings-row"><strong>오늘 남은 분석 횟수</strong><span data-sp-profile-usage>—</span></div>
                <div class="sp-settings-row"><strong>오늘 남은 응용문제 횟수</strong><span data-sp-profile-advanced>—</span></div>
                <div class="sp-privacy-box">
                    <h4>🔐 개인정보·데이터 처리 안내 (베타)</h4>
                    <p>계정 운영을 위해 이름, 이메일, 비밀번호의 해시값 등을 저장합니다. 학생이 입력한 문제·답안·학습 기록과 사진을 학습 추천·분석·복습에 사용합니다. 문제 및 사진은 AI 분석을 위해 외부 AI 서비스로 전송될 수 있으며, 사진 저장에는 Cloudflare R2를 사용합니다. 로그인 유지에는 세션 쿠키가 사용됩니다.</p>
                </div>
                <div class="sp-privacy-box">
                    <h4>📄 정식 정책 준비 상태</h4>
                    <p>이 화면은 개인정보 처리방침 전문이 아닙니다. 운영자 연락처, 데이터 보관·파기 기간, 위탁·국외 이전 사항, 열람·정정·삭제 요청 절차와 정식 이용약관은 서비스 공개 전에 별도 문서로 확인·게시해야 합니다. 현재 앱 내 이메일 변경, 비밀번호 재설정 및 계정 탈퇴 기능은 제공하지 않습니다.</p>
                </div>
                <button type="button" class="sp-hub-logout" data-sp-hub-logout>로그아웃</button>
            </div>
        `;
        const anchor = $("cardPricing");
        if (anchor?.parentElement) {
            anchor.insertAdjacentElement("afterend", hub);
        } else {
            shell.appendChild(hub);
        }
        hub.dataset.spHubView = "pricing";
        hub.addEventListener("click", (event) => {
            const tabButton = event.target.closest("[data-sp-hub-tab]");
            if (tabButton) {
                hub.dataset.spHubView = tabButton.dataset.spHubTab;
                scorePathRenderMemberHubV01();
                return;
            }
            if (event.target.closest("[data-sp-hub-logout]")) {
                void logout();
            }
        });
    }
    scorePathRenderMemberHubV01();
}

function scorePathRenderMemberHubV01() {
    const hub = $("cardScorePathMemberHubV01");
    if (!hub) return;
    const currentView = hub.dataset.spHubView === "privacy" ? "privacy" : "pricing";
    hub.querySelectorAll("[data-sp-hub-section]").forEach((section) => {
        const show = section.dataset.spHubSection === currentView;
        section.hidden = !show;
        section.style.display = show ? "" : "none";
    });
    hub.querySelectorAll("[data-sp-hub-tab]").forEach((button) => {
        button.setAttribute("aria-selected", String(button.dataset.spHubTab === currentView));
    });

    const user = dashboardState?.user || {};
    const plan = String(user.plan || "free");
    const planName = plan === "premium9900"
        ? "월 9,900원 유료"
        : plan === "free"
            ? "무료"
            : "이전 테스트 요금제";
    const write = (selector, value) => {
        const target = hub.querySelector(selector);
        if (target) target.textContent = String(value);
    };
    const rule = dashboardState?.planRule || {};
    const remainAi = Math.max(0, Number(rule.aiDaily || 0) - Number(dashboardState?.usageAi?.count || 0));
    const advanced = dashboardState?.advancedUsage || {};
    write("[data-sp-current-plan]", planName);
    write("[data-sp-profile-name]", user.name || "—");
    write("[data-sp-profile-email]", user.email || "—");
    write("[data-sp-profile-plan]", planName);
    write("[data-sp-profile-usage]", `${remainAi}회 / 하루 ${Number(rule.aiDaily || 0)}회`);
    write("[data-sp-profile-advanced]", advanced.testUnlimited
        ? "개발 테스트 모드 (제한 해제)"
        : `${Math.max(0, Number(advanced.remaining || 0))}회 / 하루 ${Number(advanced.limit || 0)}회`);
}


function setScorePathMainNavigationV01(tab) {

    // =====================================
    // ScorePath 21-123
    // 기존 카드를 유지하면서 4개 화면 분리
    // =====================================

     const nav = $("scorePathMainNavigationV01");

    if (!nav) return;

    // 요금제·개인정보 UI 생성(기존 학습 기록 변경 없음)
    scorePathEnsureMemberHubV01();

    // 기존 함수의 "study" 호출은 유지하면서
    // 실제 화면은 홈 + 문제풀이로 통합한다.
    const goToInput = tab === "study";

    if (goToInput) {
        tab = "home";
    }

    // =====================================
    // 하단 메뉴 3개로 정리
    // 홈 / 기록 / 시험
    // =====================================

    nav.querySelector(
        '[data-main-tab="study"]'
    )?.remove();

    const recordButton =
        nav.querySelector(
            '[data-main-tab="review"]'
        );

    if (recordButton) {

        recordButton.setAttribute(
            "aria-label",
            "문제 및 학습 기록"
        );

        const label =
            recordButton.querySelector(
                "span:last-child"
            );

        if (label) {
            label.textContent = "기록";
        }
    }

    // =====================================
    // 화면 구성
    // =====================================

    const pages = {

        // 홈: 추천 + 문제 입력 + 분석 결과
        home: [
            "cardExamMode",
            "cardInput",
            "cardAnalysis",
            "cardSimilar",
            "cardAdvanced"
        ],

        // 기존 코드 호환용
        study: [
            "cardInput",
            "cardAnalysis",
            "cardSimilar",
            "cardAdvanced"
        ],

        // 오답 및 복습
        review: [
            "cardTodayLearning",
            "cardSummary",
            "cardSubjectStats",
            "cardWrong",
            "cardSolved",
            "cardTrash"
        ],

        // 시험 관리
        exams: [
            "cardExamMode"
        ],

        // 요금제·개인정보/설정
        account: [
            "cardScorePathMemberHubV01"
        ]
    };

    if (!Object.hasOwn(pages, tab)) {
        return;
    }

    // =====================================
    // 선택한 화면의 카드만 표시
    // =====================================

    const visibleIds =
        new Set(pages[tab]);

    const allIds =
        new Set(
            Object.values(pages).flat()
        );

    // 구형 개발 테스트 요금제 카드가 사용자에게 노출되지 않도록 숨김
    allIds.add("cardPricing");

    // =====================================
    // ScorePath 21-131
    // 오답·복습 상세 통계 접기
    // =====================================

    const mainStats =
        $("cardSummary");

    const subjectStats =
        $("cardSubjectStats");

    let fold =
        $("scorePathReviewStatsDisclosureV01");

    // =====================================
    // 접이식 통계 영역 최초 생성
    // =====================================

    if (
        !fold &&
        mainStats &&
        subjectStats &&
        mainStats.parentElement ===
            subjectStats.parentElement
    ) {

        fold =
            document.createElement("details");

        fold.id =
            "scorePathReviewStatsDisclosureV01";

        fold.style.cssText =
            "padding:14px 16px;" +
            "margin-bottom:14px;" +
            "background:#fff;" +
            "border:1px solid #e3eaf5;" +
            "border-radius:16px;";

        const heading =
            document.createElement("summary");

        heading.textContent =
            "📊 상세 통계 펼쳐보기";

        heading.style.cssText =
            "cursor:pointer;" +
            "font-weight:700;";

        fold.appendChild(heading);

        // 기존 통계 카드의 위치를 묶는다.
        // 카드 자체는 삭제하거나 복사하지 않는다.
        mainStats.before(fold);

        fold.append(
            mainStats,
            subjectStats
        );
    }

    // =====================================
    // 오답·복습 화면에서만 표시
    // =====================================

    if (fold) {

        fold.hidden =
            tab !== "review";

        fold.style.display =
            tab === "review"
                ? ""
                : "none";
    }

    // =====================================
    // ScorePath 21-185
    // 지난 복습 기록 / 휴지통 접기
    // =====================================

    const solvedCard = $("cardSolved");
    const trashCard = $("cardTrash");

    let archiveFold =
        $("scorePathReviewArchiveDisclosureV01");

    // 접이식 영역은 한 번만 생성
    if (
        !archiveFold &&
        solvedCard &&
        trashCard &&
        solvedCard.parentElement ===
            trashCard.parentElement
    ) {

        archiveFold =
            document.createElement("details");

        archiveFold.id =
            "scorePathReviewArchiveDisclosureV01";

        archiveFold.style.cssText =
            "padding:14px 16px;" +
            "margin-bottom:14px;" +
            "background:#fff;" +
            "border:1px solid #e3eaf5;" +
            "border-radius:16px;";

        const archiveHeading =
            document.createElement("summary");

        archiveHeading.textContent =
            "📁 복습 완료 기록 · 휴지통";

        archiveHeading.style.cssText =
            "cursor:pointer;font-weight:700;";

        archiveFold.appendChild(archiveHeading);

        // 기존 카드와 데이터를 유지
        solvedCard.before(archiveFold);

        archiveFold.append(
            solvedCard,
            trashCard
        );
    }

    // =====================================
    // ScorePath 노트 화면 간소화
    // =====================================

    if (archiveFold) {

        archiveFold.hidden =
            tab !== "review";

        archiveFold.style.display =
            tab === "review"
                ? ""
                : "none";
    }

    // =====================================
    // 노트를 기록 화면 최상단에 배치
    // =====================================

    const notePage =
        $("cardTodayLearning");

    const wrongCard =
        $("cardWrong");

    if (
        notePage &&
        wrongCard &&
        solvedCard
    ) {

        // 기존 카드를 복사하지 않고 이동
        if (
            wrongCard.parentElement !== notePage ||
            solvedCard.parentElement !== notePage
        ) {

            notePage.prepend(
                wrongCard,
                solvedCard
            );
        }

        // 화면에 표시되는 이름 변경
        wrongCard.querySelector("h2").textContent =
            "📒 내 노트 · 틀린 문제";

        solvedCard.querySelector("h2").textContent =
            "📗 내 노트 · 맞힌 문제";
    }

    for (const id of allIds) {

        const card = $(id);

        if (!card) {
            continue;
        }

        // =====================================
        // ScorePath 일반 홈 / 시험 화면 구분
        // =====================================

        // 선택된 시험이 없는 일반 홈에서는
        // 기존 시험 전용 카드를 숨긴다.

        const hideExamCard =
            id === "cardExamMode" &&
            tab === "home" &&
            !selectedExamState?.examId;

        // 기존 카드 표시 기능 유지
        card.style.display =
            visibleIds.has(id) && !hideExamCard
                ? ""
                : "none";
    }

     // =====================================
    // ScorePath V1
    // 일반 / 시험 전광판 전환
    // =====================================

    const generalBoard =
        $("scorePathGeneralBoardV01");

    const examModeOn =
        Boolean(
            selectedExamState?.examId
        );

    // 일반 전광판
    if (generalBoard) {

        generalBoard.hidden =
            examModeOn;
    }

    // 시험 전광판
    const examCard =
        $("cardExamMode");

    if (examCard && tab === "home") {

        examCard.style.display =
            examModeOn
                ? ""
                : "none";
    }

    // 기존 화면 상태 유지
    document.documentElement.dataset.scorepathMainTab =
        tab;

    // =====================================
    // ON/OFF 버튼 생성 및 상태 갱신
    // =====================================

    setupScorePathExamModeSwitchV01();

    // =====================================
    // ScorePath 21-190
    // 성장 화면: 학습 성과와 변화
    // =====================================

    if (tab === "review") {

        const panel =
            $("scorePathGrowthProgressV01");

        if (panel) {

            panel.textContent =
                "학습 기록을 불러오는 중...";

            const accountKey = String(
                dashboardState?.user?.id ||
                dashboardState?.user?.email ||
                ""
            );

            // 다른 화면이나 계정으로 이동했는지 확인
            const stillCurrent = () =>
                document.documentElement
                    .dataset.scorepathMainTab === "review" &&

                accountKey === String(
                    dashboardState?.user?.id ||
                    dashboardState?.user?.email ||
                    ""
                );

            (async () => {

                try {

                    // =====================================
                    // 1. 분석할 시험 선택
                    // =====================================

                    const examData =
                        await api("/api/exams");

                    if (!stillCurrent()) return;

                    const exams =
                        Array.isArray(examData.exams)
                            ? examData.exams
                            : [];

                    const exam =
                        exams.find(
                            item =>
                                String(item.id) ===
                                String(
                                    selectedExamState?.examId
                                )
                        ) ||

                        exams.find(
                            item => !item.isPast
                        ) ||

                        exams[0];

                    if (!exam) {

                        panel.textContent =
                            "시험을 등록하면 학습 변화 기록을 확인할 수 있어요.";

                        return;
                    }

                    // =====================================
                    // 2. 기존 학습 기록 불러오기
                    // =====================================

                    const data = await api(
                        `/api/scorepath/study/history?examId=${
                            encodeURIComponent(exam.id)
                        }`
                    );

                    if (!stillCurrent()) return;

                    const summary =
                        data.summary || {};

                    // =====================================
                    // ScorePath 21-195
                    // 최근 학습 결과 및 추천 변화
                    // =====================================

                    // 가장 최근 완료한 학습
                    const latestStudy =
                        Array.isArray(data.sessions)
                            ? data.sessions[0] || null
                            : null;

                    // 전광판의 최근 학습 분석
                    const boardLatest =
                        exam.learningBoard
                            ?.lastCompletedStudy || null;

                    // 서로 같은 학습 기록인지 확인
                    const latestCompletedAt =
                        Number(latestStudy?.completedAt);

                    const boardCompletedAt =
                        Number(boardLatest?.completedAt);

                    const sameStudy =
                        latestStudy !== null &&
                        boardLatest !== null &&
                        Number.isFinite(latestCompletedAt) &&
                        latestCompletedAt > 0 &&
                        latestCompletedAt ===
                            boardCompletedAt;

                    // 학습 전후 추천 비교
                    const recommendationComparison =
                        sameStudy
                            ? boardLatest.recommendationComparison
                            : null;

                    // 현재 추천 1순위
                    const nextRecommendation =
                        exam.dailyStudyPlan
                            ?.sessions?.[0] || null;

                    // 최근 학습 결과
                    const latestResults =
                        latestStudy?.results || {};

                    const comparisons = (
                        Array.isArray(data.unitStats)
                            ? data.unitStats
                            : []
                    )
                        .filter(
                            item =>
                                item.accuracyChange != null
                        )
                        .slice(0, 3);

                    // =====================================
                    // 3. 성장 화면 출력
                    // =====================================

                    panel.innerHTML = `

                        <h3>
                            📈 ${escapeHtml(
                                exam.name ||
                                exam.subject ||
                                "시험"
                            )} 학습 기록
                        </h3>

                        <p>
                            완료
                            ${Number(
                                summary.completedSessions
                            ) || 0}회

                            · 기록된 시간
                            ${Number(
                                summary.totalMinutes
                            ) || 0}분

                            · 풀이
                            ${Number(
                                summary.totalAttempts
                            ) || 0}문제
                        </p>

                        <div class="scorepath-growth-comparisons">

                            ${
                                comparisons.length

                                    ? comparisons.map(
                                        item => `

                                            <div>
                                                <strong>
                                                    ${escapeHtml(
                                                        item.unit
                                                    )}
                                                </strong>

                                                <!-- ScorePath 21-194 -->

                                                <button
                                                    type="button"
                                                    class="secondary-btn"
                                                    data-scorepath-growth-action
                                                    data-scorepath-growth-exam="${escapeHtml(
                                                        String(exam.id)
                                                    )}"
                                                    data-scorepath-growth-subject="${escapeHtml(
                                                        exam.subject || ""
                                                    )}"
                                                    data-scorepath-growth-unit="${escapeHtml(
                                                        item.unit || ""
                                                    )}"
                                                >
                                                    📚 추천 학습으로 연결
                                                </button>

                                                <span>
                                                    ${Number(
                                                        item.previousAccuracy
                                                    )}%
                                                    →
                                                    ${Number(
                                                        item.recentAccuracy
                                                    )}%

                                                    (
                                                    ${
                                                        Number(
                                                            item.accuracyChange
                                                        ) > 0 ? "+" : ""
                                                    }${
                                                        Number(
                                                            item.accuracyChange
                                                        )
                                                    }%p
                                                    )
                                                </span>
                                            </div>

                                        `
                                    ).join("")

                                    : `
                                        <p>
                                            같은 단원에서 5문제 이상
                                            풀이한 회차가 2번 쌓이면
                                            정답률 변화를 보여줘요.
                                        </p>
                                    `
                            }

                        </div>

                        <small>
                            회차별 정답률 비교입니다.
                            문제 난이도 차이가 있을 수 있어
                            실제 성적 향상을 의미하지는 않습니다.
                        </small>

                        <!-- =====================================
                             ScorePath 21-196
                             최근 학습과 추천 변화
                        ===================================== -->

                        ${
                            latestStudy
                                ? `
                                    <section
                                        class="scorepath-study-change"
                                    >

                                        <h4>
                                            🔄 최근 공부 후 추천 변화
                                        </h4>

                                        <p>
                                            <strong>
                                                📚 공부한 단원
                                            </strong>

                                            ${escapeHtml(
                                                latestStudy.unit || ""
                                            )}
                                        </p>

                                        <p>
                                            <strong>
                                                ⏱️ 학습 기록
                                            </strong>

                                            ${
                                                Number(
                                                    latestStudy.actualMinutes
                                                ) || 0
                                            }분

                                            · 문제

                                            ${
                                                Number(
                                                    latestResults.attempts
                                                ) || 0
                                            }개
                                        </p>

                                        <p>
                                            <strong>
                                                ✅ 이번 학습 정답률
                                            </strong>

                                            ${
                                                typeof latestResults.accuracy
                                                    === "number"

                                                    ? latestResults.accuracy + "%"

                                                    : "측정 기록 부족"
                                            }
                                        </p>

                                        <div
                                            class="scorepath-study-change-result"
                                        >

                                            <strong>
                                                🎯 추천 1순위 변화
                                            </strong>

                                            ${
                                                recommendationComparison

                                                    ? `
                                                        <p>
                                                            이전:
                                                            ${escapeHtml(
                                                                recommendationComparison.before
                                                            )}
                                                        </p>

                                                        <p>
                                                            현재:
                                                            ${escapeHtml(
                                                                recommendationComparison.after
                                                            )}
                                                        </p>

                                                        <b>
                                                            ${
                                                                recommendationComparison.changed
                                                                    ? "🔄 추천 변경"
                                                                    : "📌 추천 유지"
                                                            }
                                                        </b>
                                                    `

                                                    : `
                                                        <p>
                                                            비교할 추천 기록이 부족합니다.
                                                        </p>
                                                    `
                                            }

                                        </div>

                                        ${
                                            nextRecommendation

                                                ? `
                                                    <p>
                                                        <strong>
                                                            💡 현재 추천 근거
                                                        </strong>
                                                    </p>

                                                    <p>
                                                        ${escapeHtml(
                                                            nextRecommendation.reason ||
                                                            "현재 학습 기록과 시험 조건을 참고했습니다."
                                                        )}
                                                    </p>
                                                `

                                                : `
                                                    <p>
                                                        현재 추천할 학습이 없습니다.
                                                    </p>
                                                `
                                        }

                                        <small>
                                            추천은 학습 기록과 시험 조건을
                                            바탕으로 다시 계산됩니다.
                                            추천이 변경된 정확한 원인을
                                            이 비교만으로 확정할 수는 없습니다.
                                        </small>

                                    </section>
                                `

                                : `
                                    <section
                                        class="scorepath-study-change"
                                    >
                                        <h4>
                                            🔄 최근 공부 후 추천 변화
                                        </h4>

                                        <p>
                                            완료한 학습 기록이 아직 없습니다.
                                        </p>
                                    </section>
                                `
                        }

                    `;

                } catch (error) {

                    if (stillCurrent()) {

                        panel.textContent =
                            "학습 기록을 불러오지 못했습니다. " +
                            "잠시 후 다시 확인해 주세요.";
                    }
                }

            })();
        }
    }

    // =====================================
    // ScorePath 21-135
    // 홈 / 시험 관리 화면 구분
    // =====================================

    const examListView =
        $("examListView");

    const examRiskView =
        $("examRiskView");

    const examStudyView =
        $("examStudyView");

    const examResultView =
        $("examResultView");

    // =====================================
    // 홈: 현재 시험의 전광판
    // =====================================

    if (tab === "home") {

        if (examListView) {
            examListView.hidden = true;
        }

        if (examRiskView) {
            examRiskView.hidden =
                !Boolean(
                    selectedExamState?.examId
                );
        }

        if (examStudyView) {
            examStudyView.hidden = true;
        }

        if (examResultView) {
            examResultView.hidden = true;
        }
    }

    // =====================================
    // 시험 관리: 시험 등록 및 목록
    // =====================================

    if (tab === "exams") {

        if (examListView) {
            examListView.hidden = false;
        }

        if (examRiskView) {
            examRiskView.hidden = true;
        }

        if (examStudyView) {
            examStudyView.hidden = true;
        }

        if (examResultView) {
            examResultView.hidden = true;
        }
    }

    // =====================================
    // 하단 메뉴 선택 상태 표시
    // =====================================

    nav.querySelectorAll(
        "[data-main-tab]"
    ).forEach((button) => {

        const active =
            button.dataset.mainTab === tab;

        button.setAttribute(
            "aria-pressed",
            String(active)
        );

        button.style.background =
            active ? "#2563eb" : "#fff";

        button.style.color =
            active ? "#fff" : "#334155";
    });

    // =====================================
    // 화면 전환 후 위치 이동
    // =====================================

      // =====================================
    // ScorePath UI 통합
    // 화면 이동 처리
    // =====================================

    requestAnimationFrame(() => {

        // 공부 시작 시 문제 입력창으로 이동
        if (goToInput) {

            $("problem")?.scrollIntoView({
                block: "start"
            });

        }

        // 학습 기록 화면
        else if (tab === "review") {

            const growthStart =
                $("cardTodayLearning") ||
                $("cardWrong");

            growthStart?.scrollIntoView({
                block: "start"
            });

        }

        // =====================================
        // ScorePath 홈 화면 이동
        // =====================================

        else if (tab === "home") {

            // 선택된 시험이 있으면 시험 전광판,
            // 없으면 일반 문제풀이 영역으로 이동한다.

            const target =
                selectedExamState?.examId
                    ? $("examRiskView")
                    : $("cardInput");

            target?.scrollIntoView({
                behavior: "smooth",
                block: "start"
            });

        }

        // 시험 관리 화면
        else if (tab === "exams") {

            $("examListView")?.scrollIntoView({
                block: "start"
            });

        }

        // 요금제·개인정보/설정 화면
        else if (tab === "account") {
            $("cardScorePathMemberHubV01")?.scrollIntoView({
                block: "start"
            });
        }

    });
}


// =====================================
// 메인 메뉴 생성
// =====================================

function setupScorePathMainNavigationV01() {

    const shell = $("appShell");

    if (
        !shell ||
        $("scorePathMainNavigationV01")
    ) {
        return;
    }

    const nav =
        document.createElement("nav");

    nav.id =
        "scorePathMainNavigationV01";

    nav.setAttribute(
        "aria-label",
        "ScorePath 메인 메뉴"
    );

        // =====================================
        // ScorePath 21-121
        // 모바일 친화적인 하단 내비게이션
        // =====================================

        nav.style.cssText =
            "position:fixed;" +
            "bottom:calc(10px + env(safe-area-inset-bottom, 0px));" +
            "left:50%;" +
            "transform:translateX(-50%);" +
            "z-index:999;" +
            "display:flex;" +
            "gap:6px;" +
            "padding:8px;" +
            "width:min(720px, calc(100% - 24px));" +
            "box-sizing:border-box;" +
            "overflow-x:auto;" +
            "background:#f8fafc;" +
            "border:1px solid #e2e8f0;" +
            "border-radius:14px;" +
            "box-shadow:0 4px 20px #0002;";

        // 하단 메뉴가 기존 버튼을 가리지 않도록
        // 앱 아래쪽에 여유 공간을 확보한다.
        shell.style.paddingBottom =
            "calc(100px + env(safe-area-inset-bottom, 0px))";

     // =====================================
    // ScorePath 21-176
    // 모바일 앱형 하단 메뉴
    // =====================================

    nav.innerHTML = `
        <button
            type="button"
            data-main-tab="home"
            aria-label="홈 전광판"
        >
            <span
                class="scorepath-nav-icon"
                aria-hidden="true"
            >🏠</span>
            <span>홈</span>
        </button>

        <button
            type="button"
            data-main-tab="study"
            aria-label="학습"
        >
            <span
                class="scorepath-nav-icon"
                aria-hidden="true"
            >📚</span>
            <span>학습</span>
        </button>

        <button
            type="button"
            data-main-tab="review"
            aria-label="성장과 복습"
        >
            <span
                class="scorepath-nav-icon"
                aria-hidden="true"
            >📈</span>
            <span>성장</span>
        </button>

        <button
            type="button"
            data-main-tab="exams"
            aria-label="시험 관리"
        >
            <span
                class="scorepath-nav-icon"
                aria-hidden="true"
            >📅</span>
            <span>시험</span>
        </button>
    `;

    // 기존 세 메뉴 유지 + 내 정보 메뉴 추가
    nav.insertAdjacentHTML("beforeend", `
        <button type="button" data-main-tab="account" aria-label="요금제와 개인정보·설정">
            <span class="scorepath-nav-icon" aria-hidden="true">👤</span>
            <span>마이</span>
        </button>
    `);

    // =====================================
    // 버튼 스타일
    // =====================================

    nav.querySelectorAll(
        "[data-main-tab]"
    ).forEach((button) => {

        button.style.cssText =
            "flex:1;min-width:80px;" +
            "white-space:nowrap;" +
            "padding:10px 6px;" +
            "border:1px solid #cbd5e1;" +
            "border-radius:9px;" +
            "font-size:13px;" +
            "cursor:pointer;";
    });

    shell.prepend(nav);

    // =====================================
    // 메뉴 클릭 이벤트
    // =====================================

    nav.addEventListener(
        "click",
        async (event) => {

            const button =
                event.target.closest(
                    "[data-main-tab]"
                );

            if (
                !button ||
                !nav.contains(button) ||
                button.disabled
            ) {
                return;
            }

            const tab =
                button.dataset.mainTab;

            button.disabled = true;

            try {

                // =========================
                // 1. 홈 - 학습 전광판
                // =========================

                                if (tab === "home") {

                    // =====================================
                    // ScorePath 일반 홈
                    // =====================================

                    // 시험이 없어도 홈에 진입할 수 있다.
                    // 예정된 시험을 자동 선택하지 않는다.
                    // 문제풀이 기능은 그대로 유지한다.

                }

                // =========================
                // 2. 학습 - 문제 입력
                // =========================

                else if (tab === "study") {

                    $("problem")
                        ?.scrollIntoView({
                            behavior: "smooth",
                            block: "start"
                        });

                    $("problem")
                        ?.focus({
                            preventScroll: true
                        });

                }

                // =========================
                // 3. 오답·복습
                // =========================

                else if (tab === "review") {

                    if (
                        $("wrongSectionBody")?.hidden
                    ) {

                        $("toggleWrongBtn")?.click();
                    }

                    (
                        $("toggleWrongBtn") ||
                        $("wrongSectionBody")
                    )?.scrollIntoView({
                        behavior: "smooth",
                        block: "start"
                    });

                }

                // =========================
                // 4. 시험 관리
                // =========================

                else if (tab === "exams") {

                    await loadExamList();

                    $("examListView")
                        ?.scrollIntoView({
                            behavior: "smooth",
                            block: "start"
                        });
                }

                setScorePathMainNavigationV01(
                    tab
                );

            } catch (error) {

                console.error(
                    "SCOREPATH NAV ERROR:",
                    error
                );

                alert(
                    error.message ||
                    "화면 이동 중 오류가 발생했습니다."
                );

            } finally {

                button.disabled = false;
            }
        }
    );

    // =====================================
    // ScorePath 21-122
    // 하단 메뉴 좌우 스와이프
    // =====================================

    let swipeStart = null;

    nav.addEventListener(
        "touchstart",
        (event) => {

            if (event.touches.length !== 1) {
                swipeStart = null;
                return;
            }

            swipeStart = {
                x: event.touches[0].clientX,
                y: event.touches[0].clientY
            };
        },
        {
            passive: true
        }
    );

    nav.addEventListener(
        "touchend",
        (event) => {

            if (
                !swipeStart ||
                event.changedTouches.length !== 1
            ) {
                return;
            }

            const dx =
                event.changedTouches[0].clientX -
                swipeStart.x;

            const dy =
                event.changedTouches[0].clientY -
                swipeStart.y;

            swipeStart = null;

            // 일반적인 터치나 세로 움직임은 무시
            if (
                Math.abs(dx) < 75 ||
                Math.abs(dx) <
                    Math.abs(dy) * 1.5
            ) {
                return;
            }

            // 스와이프 뒤 버튼 클릭이
            // 중복 발생하지 않도록 처리
            event.preventDefault();

            const buttons =
                [...nav.querySelectorAll(
                    "[data-main-tab]"
                )];

            const currentIndex =
                buttons.findIndex(
                    (button) =>
                        button.getAttribute(
                            "aria-pressed"
                        ) === "true"
                );

            if (currentIndex < 0) {
                return;
            }

            const nextIndex =
                Math.max(
                    0,
                    Math.min(
                        buttons.length - 1,

                        currentIndex +
                        (dx < 0 ? 1 : -1)
                    )
                );

            if (nextIndex !== currentIndex) {
                buttons[nextIndex]?.click();
            }
        },
        {
            passive: false
        }
    );

    // =====================================
    // ScorePath 21-125
    // 시험 목록 복귀 + 화면 스와이프
    // =====================================

    // =====================================
    // 시험 목록으로 돌아가기
    // =====================================

    $("backToExamListBtn")?.addEventListener(
        "click",
        () => {

            setScorePathMainNavigationV01(
                "exams"
            );
        }
    );

    $("finishExamStudyBtn")?.addEventListener(
        "click",
        () => {

            setScorePathMainNavigationV01(
                "exams"
            );
        }
    );

    // =====================================
    // 전체 화면 스와이프
    // =====================================

    let pageSwipeStart = null;

    // =====================================
    // ScorePath 3개 화면 구조
    // =====================================

    const tabOrder = [
        "home",
        "review",
        "exams"
    ];

    // 다른 터치 기능과 충돌 방지
    const skipSwipeSelector = [

        "input",
        "textarea",
        "select",
        "button",
        "[contenteditable]",

        "#scorePathMainNavigationV01",

        "#scorePathExamTabsV01",

        "#examRiskView",

        "#imageCropModal",

        "#scorePathBankOverlay"

    ].join(",");

    // =====================================
    // 터치 시작
    // =====================================

    shell.addEventListener(
        "touchstart",
        (event) => {

            if (
                event.touches.length !== 1 ||

                event.target.closest(
                    skipSwipeSelector
                )
            ) {

                pageSwipeStart = null;

                return;
            }

            pageSwipeStart = {

                x:
                    event.touches[0].clientX,

                y:
                    event.touches[0].clientY
            };

        },
        {
            passive: true
        }
    );

    // =====================================
    // 터치 종료
    // =====================================

    shell.addEventListener(
        "touchend",
        (event) => {

            if (
                !pageSwipeStart ||

                event.changedTouches.length !== 1
            ) {
                return;
            }

            const dx =
                event.changedTouches[0].clientX -
                pageSwipeStart.x;

            const dy =
                event.changedTouches[0].clientY -
                pageSwipeStart.y;

            pageSwipeStart = null;

            // 짧은 터치와 세로 스크롤 무시
            if (
                Math.abs(dx) < 85 ||

                Math.abs(dx) <
                    Math.abs(dy) * 1.8
            ) {
                return;
            }

            const tab =
                document.documentElement.dataset
                    .scorepathMainTab;

            const index =
                tabOrder.indexOf(tab);

            const next =
                tabOrder[
                    index + (dx < 0 ? 1 : -1)
                ];

            if (
                index < 0 ||
                !next
            ) {
                return;
            }

            // 기존 메뉴 클릭 이벤트 재사용
            nav.querySelector(
                `[data-main-tab="${next}"]`
            )?.click();

        },
        {
            passive: true
        }
    );

    setScorePathMainNavigationV01(
        "home"
    );
}


// =====================================
// ScorePath V1
// 무료 일반 학습 전광판
// =====================================

// =====================================
// ScorePath 21-263
// 일반 모드 추천 공부 자동 연결
// =====================================

// =====================================
// ScorePath 21-275
// 일반 공부 새로고침 복원 안내
// =====================================

function renderScorePathGeneralResumeNoticeV01() {

    const home = $("cardInput");
    let notice = $("scorePathGeneralResumeNoticeV01");
    const active = dashboardState?.generalStudySummary?.activeStudy;
    const owner = String(
        dashboardState?.user?.id ||
        dashboardState?.user?.email ||
        ""
    );

    if (!home || !owner || !active?.id) {
        notice?.remove();
        return;
    }

    // 계정 전환 시 이전 사용자 안내 제거
    if (notice && notice.dataset.owner !== owner) {
        notice.remove();
        notice = null;
    }

    if (!notice) {
        notice = document.createElement("section");
        notice.id = "scorePathGeneralResumeNoticeV01";
        notice.style.cssText =
            "padding:14px;margin:12px 0;" +
            "border:1px solid #93c5fd;border-radius:12px;" +
            "background:#eff6ff;";
        home.prepend(notice);
    }

    notice.dataset.owner = owner;

    const title = document.createElement("strong");
    title.textContent =
        `📚 진행 중인 일반 공부: ${active.subject} · ${active.unit}`;

    const info = document.createElement("p");
    info.textContent =
        "새로고침해도 공부 기록은 남아 있습니다. " +
        "이어하거나 취소할 수 있습니다.";

    const resumeButton = document.createElement("button");
    resumeButton.type = "button";
    resumeButton.className = "secondary-btn";
    resumeButton.textContent = "▶ 이어서 공부하기";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "secondary-btn";
    cancelButton.textContent = "공부 취소";
    cancelButton.style.marginLeft = "8px";

    notice.replaceChildren(title, info, resumeButton, cancelButton);

    resumeButton.onclick = () => {
        if (selectedExamState?.examId) {
            showMessage(
                "시험 모드를 끄고 일반 공부를 이어서 진행해주세요.",
                "red"
            );
            return;
        }

        // 기존 start API는 같은 과목·단원이면 세션을 재사용한다.
        startScorePathGeneralStudyV01({
            subject: active.subject,
            unit: active.unit
        });
    };

    cancelButton.onclick = async () => {
        if (!confirm(
            `일반 공부 '${active.subject} · ${active.unit}'를 취소할까요?\n` +
            "문제풀이 기록은 삭제되지 않습니다."
        )) return;

        cancelButton.disabled = true;
        resumeButton.disabled = true;

        try {
            const data = await api(
                "/api/scorepath/general-study",
                "POST",
                { action: "cancel", sessionId: active.id }
            );

            $("scorePathGeneralActiveStudyV01")?.remove();

            if (data.dashboard) {
                renderDashboard(data.dashboard);
            } else {
                notice.remove();
            }

            showMessage(
                data.message || "공부를 취소했습니다.",
                "green"
            );
        } catch (error) {
            cancelButton.disabled = false;
            resumeButton.disabled = false;
            showMessage(
                error.message || "공부 취소에 실패했습니다.",
                "red"
            );
        }
    };
}

function startScorePathGeneralStudyV01(item) {

    // =====================================
    // 1. 현재 화면 확인
    // =====================================

    if (!dashboardState) return;

    const problemInput =
        $("problem");

    if (!problemInput) return;

    // =====================================
    // 2. 추천 공부가 있는 경우
    // =====================================

    if (item) {

        const subject =
            String(
                item.subject || ""
            ).trim();

        const label =
            String(
                item.unit ||
                item.label ||
                ""
            ).trim();

        const subjectSelect =
            $("subject");

        const examSelect =
            $("scorePathExam");

        const generalUnitInput =
            $("scorePathGeneralUnit");

        // =====================================
        // 3. 과목 확인
        // =====================================

        if (
            subject &&
            subjectSelect
        ) {

            const subjectExists =
                [...subjectSelect.options]
                    .some(
                        option =>
                            option.value === subject
                    );

            if (!subjectExists) {

                showMessage(
                    "추천 과목을 찾지 못했습니다. " +
                    "과목 설정을 확인해주세요.",
                    "red"
                );

                return;
            }
        }

        // =====================================
        // 4. 일반 모드 확인
        // =====================================

        // 시험 모드가 켜져 있다면
        // 일반 추천으로 시험 상태를 변경하지 않는다.
        if (
            selectedExamState?.examId
        ) {

            showMessage(
                "현재 시험 모드가 활성화되어 있습니다. " +
                "일반 모드로 전환한 뒤 이용해주세요.",
                "blue"
            );

            return;
        }

        // =====================================
        // 5. 기존 시험 연결 해제
        // =====================================

        // 시험 모드는 OFF이지만
        // 문제 입력창에 과거 시험 선택값이
        // 남아 있을 수 있으므로 해제한다.

        if (
            examSelect &&
            examSelect.value
        ) {

            examSelect.value = "";

            examSelect.dispatchEvent(
                new Event("change")
            );
        }

        // =====================================
        // 6. 추천 과목 자동 선택
        // =====================================

        if (
            subject &&
            subjectSelect
        ) {

            subjectSelect.value =
                subject;

            subjectSelect.dispatchEvent(
                new Event("change")
            );
        }

        // =====================================
        // 7. 추천 단원 자동 입력
        // =====================================

        if (!generalUnitInput) {

            showMessage(
                "일반 단원 입력창을 찾지 못했습니다. " +
                "일반 모드 단원 입력 기능을 확인해주세요.",
                "red"
            );

            return;
        }

        // 실제 단원이 확인되지 않은
        // 추천 문구는 단원으로 저장하지 않는다.

        const invalidLabels = [
            "단원 미지정",
            "학습 범위 확인",
            "오답 다시 풀기",
            "개념 복습",
            "취약 개념"
        ];

        const validUnit =
            label &&
            !invalidLabels.some(
                text =>
                    label === text ||
                    label.startsWith(
                        text + " ·"
                    )
            );

        generalUnitInput.value =
            validUnit
                ? label
                : "";

        // =====================================
        // 8. 학습 시작 안내
        // =====================================

        if (validUnit) {

            showMessage(
                `${subject} · ${label} 공부를 시작합니다.`,
                "blue"
            );

        } else {

            showMessage(
                "추천한 공부를 시작합니다. " +
                "단원명을 확인하고 입력해주세요.",
                "blue"
            );
        }
    }

    // =====================================
    // ScorePath 21-267
    // 일반 공부 시작 / 완료 연결
    // =====================================

    if (item) {

        const studySubject =
            $("subject")
                ?.value
                ?.trim() || "";

        const studyUnit =
            $("scorePathGeneralUnit")
                ?.value
                ?.trim() || "";

        // =====================================
        // ScorePath 21-272
        // 일반 공부 시작 전 유효성 확인
        // =====================================

        if (!studySubject) {

            showMessage(
                "공부할 과목을 먼저 선택해주세요.",
                "red"
            );

            $("subject")?.focus();

            return;
        }

        if (!studyUnit) {

            showMessage(
                "공부할 단원을 먼저 입력해주세요.",
                "red"
            );

            $("scorePathGeneralUnit")?.focus();

            return;
        }

        // =====================================
        // 기존 공부 시작 API 호출
        // =====================================

        void (async () => {

            try {

                // =====================================
                // ScorePath 21-282
                // 일반 공부 전환 확인
                // =====================================

                const startRequest = {

                    action:
                        "start",

                    subject:
                        studySubject,

                    unit:
                        studyUnit
                };

                let data;

                // =====================================
                // 1. 공부 시작 요청
                // =====================================

                try {

                    data = await api(
                        "/api/scorepath/general-study",
                        "POST",
                        startRequest
                    );

                } catch (startError) {

                    // =====================================
                    // 2. 일반 공부 충돌 여부 확인
                    // =====================================

                    if (

                        startError.status !== 409 ||

                        startError.data?.code !==
                            "GENERAL_STUDY_ACTIVE"

                    ) {

                        throw startError;
                    }

                    // =====================================
                    // 3. 기존 공부 정보
                    // =====================================

                    const active =
                        startError.data.activeStudy;

                    if (!active?.id) {

                        throw startError;
                    }

                    // =====================================
                    // 4. 사용자에게 전환 확인
                    // =====================================

                    const confirmed = confirm(

                        `현재 '${active.subject} · ${active.unit}' 공부 중입니다.\n` +

                        `취소하고 '${studySubject} · ${studyUnit}'로 전환할까요?\n` +

                        "기존 문제풀이 기록은 보존됩니다."
                    );

                    // =====================================
                    // 5. 전환하지 않는 경우
                    // =====================================

                    if (!confirmed) {

                        // 기존 공부 과목 복원
                        const subjectSelect =
                            $("subject");

                        if (

                            subjectSelect &&

                            [...subjectSelect.options].some(
                                (opt) =>
                                    opt.value === active.subject
                            )

                        ) {

                            subjectSelect.value =
                                active.subject;
                        }

                        // 기존 공부 단원 복원
                        if ($("scorePathGeneralUnit")) {

                            $("scorePathGeneralUnit").value =
                                active.unit || "";
                        }

                        showMessage(
                            "기존 공부를 유지했습니다.",
                            "blue"
                        );

                        return;
                    }

                    // =====================================
                    // 6. 확인한 공부만 전환
                    // =====================================

                    data = await api(

                        "/api/scorepath/general-study",

                        "POST",

                        {
                            ...startRequest,

                            replaceSessionId:
                                active.id
                        }
                    );

                    // =====================================
                    // 7. 오래된 학습 화면 정리
                    // =====================================

                    $(
                        "scorePathGeneralActiveStudyV01"
                    )?.remove();

                    $(
                        "scorePathGeneralResumeNoticeV01"
                    )?.remove();
                }

                // =====================================
                // 8. 대시보드 학습 상태 동기화
                // =====================================

                if (
                    dashboardState?.generalStudySummary &&
                    data.session
                ) {

                    dashboardState.generalStudySummary.activeStudy = {

                        id:
                            data.session.id,

                        subject:
                            data.session.subject,

                        unit:
                            data.session.unit,

                        startedAt:
                            data.session.startedAt
                    };
                }

                const session =
                    data.session;

                if (!session) {
                    return;
                }

                // =====================================
                // ScorePath 21-279
                // 이어서 공부하기 중복 안내 방지
                // =====================================

                // =====================================
                // 1. 기존 이어하기 안내창 확인
                // =====================================

                const resumeNotice =
                    $("scorePathGeneralResumeNoticeV01");

                // =====================================
                // 2. 공부 시작 성공 후 안내창 숨기기
                // =====================================

                if (resumeNotice) {

                    // 공부 시작 API가 성공한 이후에만
                    // 안내창을 숨긴다.
                    //
                    // 진행 중인 학습은 아래의
                    // 공부 완료 UI에서 확인할 수 있다.

                    resumeNotice.hidden = true;
                }

                // =====================================
                // 3. 기존 학습 세션 유지
                // =====================================

                // 새 세션이 생성된 경우에도,
                // 진행 중인 세션을 복원한 경우에도
                // 동일한 화면을 사용한다.

                // 세션 ID는 변경하지 않는다.
                // DB 기록도 수정하지 않는다.

                // =====================================
                // 2. 학습 완료 UI
                // =====================================

                const home =
                    $("cardInput");

                if (!home) return;

                let status =
                    $("scorePathGeneralActiveStudyV01");

                if (!status) {

                    status =
                        document.createElement("section");

                    status.id =
                        "scorePathGeneralActiveStudyV01";

                    status.style.cssText =
                        "padding:14px;" +
                        "margin:14px 0;" +
                        "border:1px solid #bfdbfe;" +
                        "border-radius:12px;" +
                        "background:#eff6ff;";

                    home.prepend(status);
                }

                // =====================================
                // 3. 진행 중인 공부 표시
                // =====================================

                const title =
                    document.createElement("strong");

                title.textContent =
                    `📚 공부 중 · ${session.subject}` +
                    (
                        session.unit
                            ? ` · ${session.unit}`
                            : " · 단원 미지정"
                    );

                const description =
                    document.createElement("p");

                 // =====================================
                // ScorePath 21-287
                // 학습 후 검증 상태 복원
                // =====================================

                description.textContent =
                    session.verificationStartedAt

                        ? "학습 후 검증 중입니다. " +
                          "이 단원의 새 문제 2개를 " +
                          "정답 확인한 뒤 아래 버튼을 누르세요."

                        : data.restored

                            ? "진행 중이던 공부를 불러왔습니다."

                            : "공부를 마치면 완료 버튼을 눌러주세요.";

                const completeButton =
                    document.createElement("button");

                completeButton.type =
                    "button";

                completeButton.className =
                    "secondary-btn";

                completeButton.textContent =
                    session.verificationStartedAt

                        ? "🧪 검증 결과 확인"

                        : "✅ 공부 완료";

                const resultBox =
                    document.createElement("p");

                resultBox.style.cssText =
                    "margin:10px 0 0;" +
                    "font-size:13px;" +
                    "color:#334155;";

                status.replaceChildren(
                    title,
                    description,
                    completeButton,
                    resultBox
                );

                // =====================================
                // 4. 공부 완료 버튼
                // =====================================

                completeButton.onclick =
                    async () => {

                        if (
                            completeButton.disabled
                        ) {
                            return;
                        }

                        completeButton.disabled =
                            true;

                        completeButton.textContent =
                            "완료 기록 저장 중...";

                        try {

                            // =====================================
                            // 완료 전 추천
                            // =====================================

                            const recommendationBefore =
                                $(
                                    "scorePathGeneralBoardV01"
                                )
                                    ?.querySelector(
                                        "[data-general-title]"
                                    )
                                    ?.textContent
                                    ?.trim() || "";

                            // =====================================
                            // 서버에 완료 기록
                            // =====================================

                            // =====================================
                            // ScorePath 21-288
                            // 학습 후 검증 및 완료 연결
                            // =====================================

                            const verificationSkip =
                                completeButton.dataset.verificationSkip ===
                                "1";

                            delete completeButton.dataset.verificationSkip;

                            const finished =
                                await api(
                                    "/api/scorepath/general-study",
                                    "POST",
                                    {
                                        action: "complete",

                                        sessionId:
                                            session.id,

                                        verificationSkip
                                    }
                                );

                            // =====================================
                            // 1. 검증이 아직 필요한 경우
                            // =====================================

                            if (
                                finished.verificationRequired === true
                            ) {

                                const count =
                                    Number(
                                        finished.verificationCount || 0
                                    );

                                title.textContent =
                                    `🧪 학습 후 검증 · ${session.subject} · ${session.unit}`;

                                description.textContent =
                                    "기존 문제와 다른 새 문제 2개를 " +
                                    "이 단원에서 풀고 각각 " +
                                    "[정답 확인]을 누르세요.";

                                resultBox.textContent =
                                    `검증 진행: ${count}/2개. ` +
                                    "완료 후 [검증 결과 확인]을 눌러주세요.";

                                completeButton.disabled =
                                    false;

                                completeButton.textContent =
                                    "🧪 검증 결과 확인";

                                // =====================================
                                // 2. 검증을 진행할 수 없는 경우
                                // =====================================

                                let skipButton =
                                    status.querySelector(
                                        '[data-scorepath-verification-skip]'
                                    );

                                if (!skipButton) {

                                    skipButton =
                                        document.createElement("button");

                                    skipButton.type =
                                        "button";

                                    skipButton.className =
                                        "secondary-btn";

                                    skipButton.dataset.scorepathVerificationSkip =
                                        "1";

                                    skipButton.textContent =
                                        "검증 건너뛰기";

                                    status.appendChild(
                                        skipButton
                                    );
                                }

                                // =====================================
                                // 3. 검증 건너뛰기 확인
                                // =====================================

                                skipButton.onclick = () => {

                                    const confirmed =
                                        confirm(

                                            "검증을 건너뛰면 숙련도 확인이 " +
                                            "완료되지 않은 상태로 저장됩니다. " +

                                            "그래도 공부를 종료할까요?"
                                        );

                                    if (!confirmed) {
                                        return;
                                    }

                                    completeButton.dataset.verificationSkip =
                                        "1";

                                    completeButton.click();
                                };

                                return;
                            }

                            // =====================================
                            // 4. 검증 완료 후 안내창 제거
                            // =====================================

                            status.querySelector(
                                '[data-scorepath-verification-skip]'
                            )?.remove();

                            // =====================================
                            // 5. 검증 결과 표시
                            // =====================================

                            const verification =
                                finished.session?.verification;

                            if (
                                verification?.status === "completed"
                            ) {

                                const note =
                                    document.createElement("p");

                                note.textContent =
                                    `🧪 학습 후 검증: ${verification.correctCount}` +
                                    `/${verification.uniqueCount}개 정답`;

                                status.appendChild(
                                    note
                                );

                            } else if (
                                verification?.status === "skipped"
                            ) {

                                const note =
                                    document.createElement("p");

                                note.textContent =
                                    "⚠️ 학습 후 검증은 건너뛰었습니다.";

                                status.appendChild(
                                    note
                                );
                            }

                            // =====================================
                            // 기존 학습 데이터 및 추천 갱신
                            // =====================================

                            if (finished.dashboard) {

                                renderDashboard(
                                    finished.dashboard
                                );
                            }

                            // =====================================
                            // 완료 후 추천
                            // =====================================

                            const recommendationAfter =
                                $(
                                    "scorePathGeneralBoardV01"
                                )
                                    ?.querySelector(
                                        "[data-general-title]"
                                    )
                                    ?.textContent
                                    ?.trim() || "";

                            // =====================================
                            // 완료 결과 표시
                            // =====================================

                            const saved =
                                finished.session || {};

                            const attempts =
                                Number(
                                    saved.attempts || 0
                                );

                            const correct =
                                Number(
                                    saved.correctAttempts || 0
                                );

                            const unique =
                                Number(
                                    saved.uniqueProblems || 0
                                );

                            const minutes =
                                Number(
                                    saved.actualMinutes || 0
                                );

                            let recommendationResult =
                                "";

                            if (
                                recommendationBefore &&
                                recommendationAfter
                            ) {

                                recommendationResult =
                                    recommendationBefore ===
                                    recommendationAfter

                                        ? "추천 유지: " +
                                          recommendationAfter

                                        : "추천 변경: " +
                                          recommendationBefore +
                                          " → " +
                                          recommendationAfter;

                            } else {

                                recommendationResult =
                                    "추천에 활용할 기록을 확인 중입니다.";
                            }

                            resultBox.textContent =

                                "✅ 공부 완료 기록 저장\n" +

                                `경과 시간: ${minutes}분\n` +

                                `풀이: ${attempts}회\n` +

                                `정답: ${correct}회\n` +

                                `서로 다른 문제: ${unique}개\n` +

                                recommendationResult;

                            resultBox.style.whiteSpace =
                                "pre-line";

                            // =====================================
                            // ScorePath 21-278
                            // 공부 완료 후 화면 상태 수정
                            // =====================================

                            // 1. 공부 제목 변경
                            title.textContent =
                                `✅ 공부 완료 · ${session.subject}` +
                                (
                                    session.unit
                                        ? ` · ${session.unit}`
                                        : ""
                                );

                            // 2. 안내 문구 변경
                            description.textContent =
                                "공부 완료 기록이 정상적으로 저장되었습니다.";

                            // 3. 이전 이어하기 안내 제거
                            $(
                                "scorePathGeneralResumeNoticeV01"
                            )?.remove();

                            // 4. 완료 버튼 상태 변경
                            completeButton.textContent =
                                "✅ 완료됨";

                            completeButton.disabled =
                                true;

                            console.info(
                                "ScorePath 일반 공부 완료:",
                                {
                                    session: saved,

                                    before:
                                        recommendationBefore,

                                    after:
                                        recommendationAfter
                                }
                            );

                        } catch (error) {

                            console.error(
                                "일반 공부 완료 오류:",
                                error
                            );

                            resultBox.textContent =
                                error.message ||
                                "완료 기록을 저장하지 못했습니다.";

                            completeButton.disabled =
                                false;

                            completeButton.textContent =
                                "✅ 공부 완료";
                        }
                    };

            } catch (error) {

                console.error(
                    "일반 공부 시작 오류:",
                    error
                );

                showMessage(
                    error.message ||
                    "공부를 시작하지 못했습니다.",
                    "red"
                );

                // =====================================
                // ScorePath 21-270
                // 이전 시험 공부 충돌 처리
                // =====================================

                if (
                    String(
                        error.message || ""
                    ).includes("시험 공부")
                ) {

                    // 진행 중인 시험 공부 확인
                    await refreshScorePathPendingExamNoticeV01();

                    // 취소 버튼이 있는 위치로 이동
                    $("scorePathPendingExamNoticeV01")
                        ?.scrollIntoView({
                            behavior: "smooth",
                            block: "center"
                        });
                }
            }

        })();
    }

    // =====================================
    // 기존 문제풀이 화면으로 이동
    // =====================================

    problemInput.scrollIntoView({
        behavior: "smooth",
        block: "center"
    });

    problemInput.focus({
        preventScroll: true
    });
}


// =====================================
// ScorePath 21-292 — 하루 시간 입력 공통 규칙
// 하루의 시간 예산과 목표일까지의 기간은 별개로 관리한다.
// =====================================

function parseScorePathDailyTimeV01(hoursValue, minutesValue) {
    const hoursText = String(hoursValue ?? "").trim();
    const minutesText = String(minutesValue ?? "").trim();

    if (!/^\d+$/.test(hoursText) || !/^\d+$/.test(minutesText)) {
        return {
            valid: false,
            error: "시간과 분에 음수가 아닌 정수를 입력해주세요."
        };
    }

    const hours = Number(hoursText);
    const minutes = Number(minutesText);
    const totalMinutes = hours * 60 + minutes;

    if (
        !Number.isSafeInteger(hours) ||
        !Number.isSafeInteger(minutes) ||
        minutes > 59 ||
        !Number.isSafeInteger(totalMinutes) ||
        totalMinutes < 5 ||
        totalMinutes > 1440
    ) {
        return {
            valid: false,
            error: "하루 공부시간은 5분~24시간 사이로 입력해주세요. (분은 0~59)"
        };
    }

    return { valid: true, hours, minutes, totalMinutes };
}

function splitScorePathDailyMinutesV01(value) {
    const totalMinutes = Number(value);
    const safeMinutes =
        Number.isSafeInteger(totalMinutes) &&
        totalMinutes >= 5 &&
        totalMinutes <= 1440
            ? totalMinutes
            : 30;

    return {
        hours: Math.floor(safeMinutes / 60),
        minutes: safeMinutes % 60,
        totalMinutes: safeMinutes
    };
}

// =====================================
// ScorePath 21-298
// 목표 날짜 및 기간 공통 계산
// =====================================

// YYYY-MM-DD 날짜 검증
function getScorePathCalendarDayV01(text) {

    const match =
        /^(\d{4})-(\d{2})-(\d{2})$/
            .exec(String(text || ""));

    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    const ms =
        Date.UTC(year, month - 1, day);

    const value = new Date(ms);

    if (
        year < 100 ||
        value.getUTCFullYear() !== year ||
        value.getUTCMonth() + 1 !== month ||
        value.getUTCDate() !== day
    ) {
        return null;
    }

    return { year, month, day, ms };
}


// 오늘 날짜
function getScorePathTodayCalendarV01(
    today = new Date()
) {

    const year = today.getFullYear();
    const month = today.getMonth() + 1;
    const day = today.getDate();

    return {
        year,
        month,
        day,
        ms: Date.UTC(year, month - 1, day)
    };
}


// 목표 날짜 또는 남은 기간 계산
function resolveScorePathGeneralGoalV01({

    mode,
    dateText = "",
    amountText = "",
    unit = "day"

}, today = new Date()) {

    const start =
        getScorePathTodayCalendarV01(today);

    let targetMs;

    // =====================================
    // 1. 직접 날짜 선택
    // =====================================

    if (mode === "date") {

        const target =
            getScorePathCalendarDayV01(dateText);

        if (!target) {

            return {
                valid: false,
                error: "목표 날짜를 정확하게 선택해주세요."
            };
        }

        targetMs = target.ms;

    }

    // =====================================
    // 2. 남은 기간 직접 입력
    // =====================================

    else if (mode === "period") {

        const raw =
            String(amountText).trim();

        if (!/^\d+$/.test(raw)) {

            return {
                valid: false,
                error: "남은 기간은 1 이상의 정수로 입력해주세요."
            };
        }

        const amount = Number(raw);

        if (
            !Number.isSafeInteger(amount) ||
            amount < 1
        ) {

            return {
                valid: false,
                error: "남은 기간은 1 이상의 정수로 입력해주세요."
            };
        }

        // 일 또는 주
        if (
            unit === "day" ||
            unit === "week"
        ) {

            const days =
                amount * (
                    unit === "week" ? 7 : 1
                );

            if (!Number.isSafeInteger(days)) {

                return {
                    valid: false,
                    error: "기간이 너무 깁니다."
                };
            }

            targetMs =
                start.ms + days * 86400000;

        }

        // 개월 또는 년
        else if (
            unit === "month" ||
            unit === "year"
        ) {

            const additionalMonths =
                amount * (
                    unit === "year" ? 12 : 1
                );

            if (
                !Number.isSafeInteger(
                    additionalMonths
                )
            ) {

                return {
                    valid: false,
                    error: "기간이 너무 깁니다."
                };
            }

            const absoluteMonth =
                start.year * 12 +
                (start.month - 1) +
                additionalMonths;

            const targetYear =
                Math.floor(absoluteMonth / 12);

            const targetMonth =
                absoluteMonth % 12 + 1;

            const endOfMonth =
                new Date(
                    Date.UTC(
                        targetYear,
                        targetMonth,
                        0
                    )
                ).getUTCDate();

            targetMs = Date.UTC(
                targetYear,
                targetMonth - 1,
                Math.min(
                    start.day,
                    endOfMonth
                )
            );

        } else {

            return {
                valid: false,
                error: "지원하지 않는 기간 단위입니다."
            };
        }

    } else {

        return {
            valid: false,
            error: "목표 설정 방식을 선택해주세요."
        };
    }

    // =====================================
    // 3. 남은 일수 계산
    // =====================================

    const daysLeft =
        Math.round(
            (targetMs - start.ms) / 86400000
        );

    if (
        !Number.isSafeInteger(daysLeft) ||
        daysLeft < 0 ||
        daysLeft > 36525
    ) {

        return {
            valid: false,
            error:
                "목표는 오늘부터 100년 이내의 날짜로 설정해주세요."
        };
    }

    return {

        valid: true,

        targetDate:
            new Date(targetMs)
                .toISOString()
                .slice(0, 10),

        daysLeft
    };
}


// =====================================
// 기존 일반 전광판
// =====================================

function renderScorePathGeneralBoardV01() {

    const home = $("cardInput");

    if (!home || !dashboardState) return;

    let board =
        $("scorePathGeneralBoardV01");

    // 전광판은 최초 한 번만 생성
    if (!board) {

        board = document.createElement("section");

        board.id =
            "scorePathGeneralBoardV01";

        board.style.cssText =
            "padding:16px;" +
            "margin-bottom:18px;" +
            "border:1px solid #bfdbfe;" +
            "border-radius:14px;" +
            "background:#eff6ff;";

        board.innerHTML = `
            <div style="
                display:flex;
                justify-content:space-between;
                gap:10px;
                flex-wrap:wrap;
                margin-bottom:12px;
            ">
                 <strong>
                    📊 학습 예측 전광판
                </strong>

                <small data-general-date></small>
            </div>

            <div style="
                font-size:12px;
                color:#2563eb;
                margin-bottom:8px;
            ">
                무료 · 학습 기록 기반 숙련도 추정 및 다음 공부 추천
            </div>

            <!-- =====================================
                 ScorePath 21-293 — 오늘 공부 가능시간
                 하루 시간과 목표일까지의 기간은 구분
            ===================================== -->

            <div style="font-size:13px; margin:10px 0 6px;">
                ⏱️ 오늘 공부 가능시간
            </div>

            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <label for="scorePathGeneralHoursV01" style="margin:0;">
                    <input id="scorePathGeneralHoursV01"
                        type="number" min="0" max="24" step="1" value="0"
                        style="width:90px; margin:0;" aria-label="공부 가능 시간">
                    시간
                </label>
                <label for="scorePathGeneralExtraMinutesV01" style="margin:0;">
                    <input id="scorePathGeneralExtraMinutesV01"
                        type="number" min="0" max="59" step="1" value="30"
                        style="width:90px; margin:0;" aria-label="공부 가능 분">
                    분
                </label>
            </div>
            <p data-general-time-error role="status"
                style="font-size:12px; color:#b91c1c; margin:5px 0 12px;"></p>

            <!-- =====================================
                 ScorePath 21-299
                 일반 학습 목표 기간
            ===================================== -->

            <div style="
                padding:12px;
                margin:10px 0;
                background:#fff;
                border:1px solid #dbeafe;
                border-radius:12px;
            ">

                <strong style="
                    display:block;
                    margin-bottom:8px;
                ">
                    🎯 목표까지 남은 기간 (선택)
                </strong>

                <label for="scorePathGeneralGoalModeV01">
                    설정 방식
                </label>

                <select id="scorePathGeneralGoalModeV01">

                    <option value="date">
                        목표 날짜 선택
                    </option>

                    <option value="period">
                        남은 기간 직접 입력
                    </option>

                </select>

                <!-- 목표 날짜 직접 선택 -->

                <div data-general-goal-date-wrap>

                    <label for="scorePathGeneralGoalDateV01">
                        목표 날짜
                    </label>

                    <input
                        id="scorePathGeneralGoalDateV01"
                        type="date"
                    >

                </div>

                <!-- 남은 기간 직접 입력 -->

                <div data-general-goal-period-wrap hidden>

                    <label for="scorePathGeneralGoalAmountV01">
                        남은 기간
                    </label>

                    <div style="
                        display:flex;
                        gap:8px;
                        flex-wrap:wrap;
                    ">

                        <input
                            id="scorePathGeneralGoalAmountV01"
                            type="number"
                            min="1"
                            step="1"
                            value="30"
                            style="width:110px;"
                        >

                        <select
                            id="scorePathGeneralGoalUnitV01"
                            aria-label="기간 단위"
                            style="width:110px;"
                        >

                            <option value="day">일</option>
                            <option value="week">주</option>
                            <option value="month">개월</option>
                            <option value="year">년</option>

                        </select>

                    </div>

                </div>

                <div class="button-row">

                    <button
                        type="button"
                        class="secondary-btn"
                        data-general-goal-save
                    >
                        목표 저장
                    </button>

                    <button
                        type="button"
                        class="secondary-btn"
                        data-general-goal-clear
                    >
                        목표 해제
                    </button>

                </div>

                <p
                    data-general-goal-info
                    role="status"
                    style="font-size:13px; margin:8px 0 0;"
                ></p>

                <!-- =====================================
                     ScorePath 21-301
                     하루 평균 공부 가능시간
                ===================================== -->

                <label style="display:block; margin:12px 0 6px; font-size:13px;">
                    ⏱️ 하루 평균 공부 가능시간 (선택)
                </label>

                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                    <input
                        id="scorePathGoalDailyHoursV01"
                        type="number"
                        min="0"
                        max="24"
                        step="1"
                        placeholder="시간"
                        aria-label="하루 평균 공부 시간"
                        style="width:90px; margin:0;"
                    >
                    <span>시간</span>

                    <input
                        id="scorePathGoalDailyMinutesV01"
                        type="number"
                        min="0"
                        max="59"
                        step="1"
                        placeholder="분"
                        aria-label="하루 평균 공부 분"
                        style="width:90px; margin:0;"
                    >
                    <span>분</span>
                </div>

                <small style="display:block; color:#64748b; margin-top:6px;">
                    휴식일을 포함한 평균을 입력하세요.
                    오늘 공부 가능시간과는 별개입니다.
                </small>

                <p
                    data-general-goal-error
                    role="alert"
                    style="color:#b91c1c; font-size:12px;"
                ></p>

                <small style="color:#64748b;">
                    목표일까지의 시간은 참고용 예산입니다.
                    현재 일반 추천 순위에는 아직 반영되지 않습니다.
                    시험 모드는 등록된 시험 날짜를 사용합니다.
                </small>

            </div>

            <h3
                data-general-title
                style="margin:8px 0;"
            ></h3>

            <!-- =====================================
                 오늘의 학습 계획
            ===================================== -->

            <div
                data-general-plan
                style="
                    margin:12px 0;
                    padding:12px;
                    background:#ffffff;
                    border:1px solid #dbeafe;
                    border-radius:12px;
                "
            ></div>

            <p data-general-reason
                style="margin:8px 0;">
            </p>

            <small
                style="
                    display:block;
                    color:#64748b;
                    margin:12px 0;
                "
            >
                저장된 기록을 기반으로 한
                임시 학습 추천입니다.
                시험 성적 예측값은 아닙니다.
            </small>

            <button
                type="button"
                class="secondary-btn"
                data-general-start
            >
                📚 공부 시작
            </button>
        `;

        // =====================================
        // ScorePath 21-307
        // 일반 전광판에서 시험 관련 설정 제거
        // =====================================

        // 일반 전광판에는 목표 날짜와 장기 학습시간
        // 설정이 필요하지 않다.
        //
        // 기존 목표 데이터를 삭제하지 않고
        // 화면에서만 제거한다.

        const generalGoalPanel =
            board.querySelector(
                "#scorePathGeneralGoalModeV01"
            )?.closest("div");

        if (
            generalGoalPanel &&
            generalGoalPanel.querySelector(
                "[data-general-goal-save]"
            )
        ) {
            generalGoalPanel.remove();
        }

        // 기존 문제풀이 화면 상단에 배치
        home.prepend(board);
    }

      // =====================================
    // ScorePath 21-254
    // 일반 전광판 학습 우선순위 V1
    // =====================================

    const today =
        dashboardState.todayLearning || {};

    const subjects =
        new Set(
            dashboardState.user?.subjects || []
        );

    // 실제 등록된 과목만 추천
    const isActive = (item) =>
        item &&
        (
            subjects.size === 0 ||
            subjects.has(item.subject)
        );

    // =====================================
    // 1. 기존 학습 데이터
    // =====================================

    const reviews =
        Array.isArray(today.reviewConcepts)
            ? today.reviewConcepts.filter(isActive)
            : [];

    const retries =
        Array.isArray(today.retryProblems)
            ? today.retryProblems.filter(isActive)
            : [];

    const weaknesses =
        Array.isArray(today.weaknessTraining)
            ? today.weaknessTraining.filter(isActive)
            : [];

    const topWeakness =
        isActive(today.topWeakness)
            ? today.topWeakness
            : null;

    // =====================================
    // ScorePath 21-259
    // 공통 숙련도 기반 학습 추천
    // =====================================

    const candidates = [];

    // =====================================
    // 1. 서버가 계산한 공통 학습 신호
    // =====================================

    const generalSignals =
        Array.isArray(
            dashboardState.generalLearningSignals
        )

            ? dashboardState.generalLearningSignals
                .filter(isActive)

            : [];

    // =====================================
    // 2. 고유 문제 기반 추천 후보
    // =====================================

    generalSignals.forEach((item) => {

        const uniqueAttempts =
            Math.max(
                0,
                Number(item.uniqueAttempts) || 0
            );

        const uniqueCorrectCount =
            Math.min(
                uniqueAttempts,

                Math.max(
                    0,
                    Number(item.uniqueCorrectCount) || 0
                )
            );

        // 기록이 없다면 추천하지 않음
        if (uniqueAttempts === 0) {
            return;
        }

        const uniqueWrongCount =
            uniqueAttempts -
            uniqueCorrectCount;

        // =====================================
        // 숙련도 계산 결과 확인
        // =====================================

        const mastery =
            item.estimatedMastery == null

                ? null

                : Number(item.estimatedMastery);

        const hasMastery =
            uniqueAttempts >= 5 &&
            mastery !== null &&
            Number.isFinite(mastery);

        // =====================================
        // 3. 학습 우선순위
        // =====================================

        let priority = 0;

        let minutes = 15;

        let reason = "";

        // -------------------------------------
        // A. 아직 숙련도 근거 부족
        // -------------------------------------

        if (!hasMastery) {

            priority =
                95 +
                Math.min(
                    uniqueWrongCount,
                    3
                ) * 8;

            minutes = 10;

            reason =
                `서로 다른 문제 ${uniqueAttempts}개를 풀었습니다. ` +
                "숙련도를 판단할 근거가 아직 부족하므로 " +
                "새로운 문제로 실력을 확인하세요.";
        }

        // -------------------------------------
        // B. 추정 숙련도 60 미만
        // -------------------------------------

        else if (mastery < 60) {

            priority =
                160 +
                Math.round(
                    (60 - mastery) * 0.4
                );

            minutes = 20;

            reason =
                `현재 추정 숙련도 ${mastery}%. ` +
                "관련 개념을 다시 학습하고 " +
                "새로운 문제로 확인하는 것을 권장합니다.";
        }

        // -------------------------------------
        // C. 추정 숙련도 60~79
        // -------------------------------------

        else if (mastery < 80) {

            priority =
                125 +
                Math.round(
                    (80 - mastery) * 0.4
                );

            minutes = 15;

            reason =
                `현재 추정 숙련도 ${mastery}%. ` +
                "부족한 유형을 추가로 연습하는 것을 권장합니다.";
        }

        // -------------------------------------
        // D. 추정 숙련도 80 이상
        // -------------------------------------

         else {

            // =====================================
            // ScorePath 21-310
            // 높은 숙련도 추정치의 근거 확인
            // =====================================

            // 숙련도 추정치가 높더라도
            // 난이도별 풀이 근거가 부족하면
            // 실력을 충분히 확인했다고 판단하지 않는다.

            const evidenceSupported =
                item.hasDifficultyCoverage === true &&
                (
                    item.evidenceLevel === "보통" ||
                    item.evidenceLevel === "넓음"
                );

            // 기존 우선순위 구간을 재사용한다.
            // 실제 성적 향상 효과가 검증된 점수는 아니다.

            priority =
                evidenceSupported ? 65 : 125;

            minutes = 10;

            reason = evidenceSupported

                ? `현재 추정 숙련도 ${mastery}%. ` +
                  "새로운 유형으로 실력을 확인하고 " +
                  "필요한 개념을 복습하세요."

                : `현재 추정 숙련도 ${mastery}%이지만 ` +
                  "난이도별 풀이 근거가 충분하지 않습니다. " +
                  "새로운 난이도의 문제로 먼저 확인하세요.";
        }

         // =====================================
        // ScorePath 21-283
        // 적은 표본에 대한 신뢰도 보정
        // =====================================

        // 5~9개만 풀었을 때는 숙련도 수치가 있어도
        // 충분히 확인된 취약 단원처럼 취급하지 않는다.
        if (hasMastery && uniqueAttempts < 10) {

            priority = Math.min(priority, 145);

            reason =
                `서로 다른 문제 ${uniqueAttempts}개로 계산한 초기 추정입니다. ` +
                reason;
        }

        // 난이도 정보가 부족하다는 이유만으로
        // 추천 점수를 높이지 않는다.
        if (
            uniqueAttempts >= 5 &&
            item.hasDifficultyCoverage !== true
        ) {

            reason +=
                " 난이도별 풀이 근거가 부족하므로 " +
                "결과를 잠정적으로 해석해주세요.";
        }

        // =====================================
        // 5. 단원 정보
        // =====================================

        const unit =
            item.unit === "단원 미지정"

                ? "단원 미지정 · 추가 확인"

                : item.unit || "학습 범위 확인";

        // =====================================
        // 6. 추천 후보 저장
        // =====================================

         // =====================================
        // ScorePath 21-304
        // 실제 풀이 근거에 따른 다음 행동
        // =====================================

        // 5개는 기존 숙련도 표시의 최소 기준이다.
        // 필요한 전체 공부량이나 성적 상승을 뜻하지 않는다.
        const missingEvidence = Math.max(0, 5 - uniqueAttempts);

        const nextAction = !hasMastery
            ? (missingEvidence > 0
                ? `초기 숙련도 판단에 고유 문제 ${missingEvidence}개가 더 필요합니다. 새 문제로 확인하세요.`
                : "숙련도 수치가 산출되지 않았습니다. 다양한 새 문제로 실력을 확인하세요.")
            : mastery < 60
                ? `첫 풀이 오답 ${uniqueWrongCount}개가 기록됐습니다. 약한 개념을 복습한 뒤 새로운 문제 2개로 확인하세요.`
                : item.hasDifficultyCoverage !== true
                    ? "다른 난이도의 새 문제를 풀어 추정 숙련도를 재확인하세요."
                    : "새 유형의 문제로 이해를 확인하고 필요할 때 복습하세요.";

        candidates.push({

            type: "learning_signal",

            subject: item.subject || "",
            label: unit,
            minutes,
            priority,
            reason,

            // 동일 단원의 다른 추천 근거와 연결하기 위한 정보
            uniqueAttempts,
            uniqueWrongCount,
            nextAction
        });
    });

    // =====================================
    // 기존 추천 후보도 그대로 유지
    // =====================================

    // -------------------------------------
    // A. 반복 오답
    // -------------------------------------

       retries.forEach((item) => {

        // =====================================
        // ScorePath 21-255
        // 반복 오답 근거 검증
        // =====================================

        // 이미 숙달한 문제는 제외
        if (
            String(item.masteryStatus)
                .toLowerCase() === "mastered"
        ) {
            return;
        }

        const repeatCount =
            Math.max(
                0,
                Number(item.repeatWrongCount) || 0
            );

        // =====================================
        // 반복 풀이 과대평가 방지
        // =====================================

        // 동일 문제를 반복해서 틀린 횟수는
        // 해당 단원 전체의 숙련도와 다르다.
        // 따라서 반복 가산점을 제한한다.

        const repeatBonus =
            Math.min(repeatCount, 3) * 10;

        const priority =
            100 + repeatBonus;

        const label =
            item.unit ||
            item.weakConcept ||
            "오답 다시 풀기";

        // =====================================
        // 추천 후보 저장
        // =====================================

        candidates.push({

            type: "retry",

            subject:
                item.subject || "",

            label,

            minutes: 15,

            priority,

            reason:
                repeatCount > 0

                    ? `반복 오답 ${repeatCount}회가 기록되었습니다. ` +
                      "해당 문제의 핵심 개념을 확인한 뒤 " +
                      "새로운 문제로 이해도를 점검하세요."

                    : "해결되지 않은 오답이 있습니다. " +
                      "틀린 이유를 복습하고 다시 확인하세요."
        });
    });

    // -------------------------------------
    // B. 복습할 개념
    // -------------------------------------

     reviews.forEach((item) => {

        // =====================================
        // ScorePath 21-256
        // 복습 시점 확인
        // =====================================

        const currentTime =
            Date.now();

        const nextReviewAt =
            Number(item.nextReviewAt);

        // 아직 복습 날짜가 되지 않았다면
        // 오늘의 복습 추천에서 제외한다.
        if (
            item.nextReviewAt != null &&
            item.nextReviewAt !== "" &&
            Number.isFinite(nextReviewAt) &&
            nextReviewAt > currentTime
        ) {
            return;
        }

        // =====================================
        // 취약도
        // =====================================

        const weaknessScore =
            Math.max(
                0,
                Number(item.weaknessScore) || 0
            );

        // =====================================
        // 복습 지연 기간
        // =====================================

        let overdueDays = 0;

        if (
            item.nextReviewAt != null &&
            Number.isFinite(nextReviewAt) &&
            nextReviewAt > 0
        ) {

            overdueDays =
                Math.max(
                    0,
                    Math.floor(
                        (
                            currentTime -
                            nextReviewAt
                        ) / 86400000
                    )
                );
        }

        // =====================================
        // 복습 우선순위
        // =====================================

        const weaknessBonus =
            Math.min(weaknessScore, 100) * 0.1;

        const overdueBonus =
            Math.min(overdueDays, 7) * 2;

        const priority =
            120 +
            weaknessBonus +
            overdueBonus;

        // =====================================
        // 추천 후보
        // =====================================

        candidates.push({

            type: "review",

            subject:
                item.subject || "",

            label:
                item.label ||
                "개념 복습",

            minutes: 10,

            priority,

            reason:
                overdueDays > 0

                    ? `복습 예정일로부터 ${overdueDays}일이 지났습니다. ` +
                      "기억하고 있는 내용을 확인하고 " +
                      "필요한 개념을 복습하세요."

                    : "오늘 복습할 개념입니다. " +
                      "기억하고 있는 내용을 먼저 확인하세요."
        });
    });

    // -------------------------------------
    // C. 취약 개념
    // -------------------------------------

      weaknesses.forEach((item) => {

        // =====================================
        // ScorePath 21-257
        // 취약 개념 근거 확인
        // =====================================

        const weaknessScore =
            Math.max(
                0,
                Number(item.weaknessScore) || 0
            );

        const wrongCount =
            Math.max(
                0,
                Number(item.wrongCount) || 0
            );

        const correctCount =
            Math.max(
                0,
                Number(item.correctCount) || 0
            );

        // =====================================
        // 기록량 확인
        // =====================================

        const totalAttempts =
            wrongCount + correctCount;

        // 전체 풀이 횟수 기준의 임시 구분
        // 고유 문제 수나 통계적 신뢰도가 아님
        const limitedEvidence =
            totalAttempts < 5;

        // =====================================
        // 우선순위 계산
        // =====================================

        const weaknessBonus =
            Math.min(weaknessScore, 100) * 0.2;

        const wrongBonus =
            Math.min(wrongCount, 5) * 5;

        // 기록이 매우 적으면
        // 높은 확신을 주지 않도록 소폭 조정
        const evidenceAdjustment =
            limitedEvidence
                ? -15
                : 0;

        const priority =
            Math.max(
                0,
                95 +
                weaknessBonus +
                wrongBonus +
                evidenceAdjustment
            );

        // =====================================
        // 추천 이유
        // =====================================

        const reason =
            limitedEvidence

                ? "현재 풀이 기록이 적어 " +
                  "취약 개념인지 확정하기 어렵습니다. " +
                  "새로운 문제를 풀어 실력을 확인하세요."

                : `기록된 오답 ${wrongCount}회가 ` +
                  "취약 가능성을 보여줍니다. " +
                  "개념을 복습하고 새로운 문제로 확인하세요.";

        // =====================================
        // 추천 후보 저장
        // =====================================

        candidates.push({

            type: "weakness",

            subject:
                item.subject || "",

            label:
                item.unit ||
                item.label ||
                item.weakConcept ||
                "취약 개념",

            minutes:
                limitedEvidence
                    ? 15
                    : 20,

            priority,

            reason
        });
    });

    // =====================================
    // 3. 추천 후보 정렬
    // =====================================

    candidates.sort(
        (a, b) =>
            b.priority - a.priority
    );

    // =====================================
    // ScorePath V1
    // 일반 학습시간 기반 추천
    // =====================================

     // =====================================
    // ScorePath 21-294 — 입력 검증 및 기존 설정 복원
    // =====================================

    const accountId = String(dashboardState.user?.id || "unknown");
    const storageKey = `scorepath-general-minutes-${accountId}`;
    const hoursInput = board.querySelector("#scorePathGeneralHoursV01");
    const extraMinutesInput = board.querySelector("#scorePathGeneralExtraMinutesV01");
    const timeError = board.querySelector("[data-general-time-error]");

    const readSavedMinutes = () => {
        try {
            const saved = localStorage.getItem(storageKey);
            return splitScorePathDailyMinutesV01(
                saved === null ? 30 : Number(saved)
            ).totalMinutes;
        } catch (error) {
            console.warn("공부시간 설정을 읽지 못했습니다.", error);
            return 30;
        }
    };

    if (
        hoursInput && extraMinutesInput &&
        hoursInput.dataset.owner !== accountId
    ) {
        const saved = splitScorePathDailyMinutesV01(readSavedMinutes());
        hoursInput.value = String(saved.hours);
        extraMinutesInput.value = String(saved.minutes);
        hoursInput.dataset.owner = accountId;
        extraMinutesInput.dataset.owner = accountId;
    }

    // 유효하지 않은 입력은 저장하지 않는다. 기존 설정으로 추천 유지.
    const entered = parseScorePathDailyTimeV01(
        hoursInput?.value ?? "0",
        extraMinutesInput?.value ?? "30"
    );
    const availableMinutes = entered.valid
        ? entered.totalMinutes
        : readSavedMinutes();

    if (timeError) timeError.textContent = entered.valid ? "" : entered.error;

    const saveDailyTime = () => {
        const parsed = parseScorePathDailyTimeV01(
            hoursInput?.value ?? "",
            extraMinutesInput?.value ?? ""
        );

        if (!parsed.valid) {
            if (timeError) timeError.textContent = parsed.error;
            return;
        }

        if (timeError) timeError.textContent = "";

        try {
            localStorage.setItem(storageKey, String(parsed.totalMinutes));
        } catch (error) {
            console.warn("공부시간 설정을 저장하지 못했습니다.", error);
        }

        // AI 호출 없이 추천 다시 계산
        renderScorePathGeneralBoardV01();
    };

    if (hoursInput) hoursInput.onchange = saveDailyTime;
    if (extraMinutesInput) extraMinutesInput.onchange = saveDailyTime;

    // =====================================
    // ScorePath 21-300
    // 목표 저장 및 새로고침 복원
    // =====================================

    const goalStorageKey =
        `scorepath-general-goal-${accountId}`;

    const goalMode =
        board.querySelector(
            "#scorePathGeneralGoalModeV01"
        );

    const goalDate =
        board.querySelector(
            "#scorePathGeneralGoalDateV01"
        );

    const goalAmount =
        board.querySelector(
            "#scorePathGeneralGoalAmountV01"
        );

    const goalUnit =
        board.querySelector(
            "#scorePathGeneralGoalUnitV01"
        );

    const goalDateWrap =
        board.querySelector(
            "[data-general-goal-date-wrap]"
        );

    const goalPeriodWrap =
        board.querySelector(
            "[data-general-goal-period-wrap]"
        );

    const goalInfo =
        board.querySelector(
            "[data-general-goal-info]"
        );

    const goalError =
        board.querySelector(
            "[data-general-goal-error]"
        );

    // =====================================
    // 1. 저장된 목표 읽기
    // =====================================

    const readGoal = () => {

        try {

            const stored =
                JSON.parse(
                    localStorage.getItem(goalStorageKey) ||
                    "null"
                );

            return stored &&
                typeof stored === "object"
                    ? stored
                    : null;

        } catch (error) {

            console.warn(
                "목표 기간 설정을 읽지 못했습니다.",
                error
            );

            return null;
        }
    };

    // =====================================
    // 2. 날짜 / 기간 입력창 전환
    // =====================================

    const updateGoalControls = () => {

        const usePeriod =
            goalMode?.value === "period";

        if (goalDateWrap) {
            goalDateWrap.hidden = usePeriod;
        }

        if (goalPeriodWrap) {
            goalPeriodWrap.hidden = !usePeriod;
        }
    };

    // =====================================
    // =====================================
    // ScorePath 21-302: 평균 공부시간 복원
    // =====================================

    const goalDailyHours =
        board.querySelector("#scorePathGoalDailyHoursV01");

    const goalDailyMinutes =
        board.querySelector("#scorePathGoalDailyMinutesV01");

    // =====================================
    // 3. 계정별 목표 복원
    // =====================================

    if (
        goalMode &&
        goalMode.dataset.owner !== accountId
    ) {
        const stored = readGoal();

        goalMode.value =
            stored?.mode === "period" ? "period" : "date";

        if (goalDate) {
            goalDate.value = String(stored?.targetDate || "");
        }

        if (goalAmount) {
            goalAmount.value = String(stored?.amount ?? 30);
        }

        if (goalUnit) {
            goalUnit.value =
                ["day", "week", "month", "year"].includes(stored?.unit)
                    ? stored.unit
                    : "day";
        }

        const average = stored?.averageDailyMinutes;

        const averageIsValid =
            average !== null &&
            average !== undefined &&
            Number.isSafeInteger(average) &&
            average >= 5 &&
            average <= 1440;

        const parts = averageIsValid
            ? splitScorePathDailyMinutesV01(average)
            : null;

        if (goalDailyHours) {
            goalDailyHours.value =
                parts ? String(parts.hours) : "";
        }

        if (goalDailyMinutes) {
            goalDailyMinutes.value =
                parts ? String(parts.minutes) : "";
        }

        goalMode.dataset.owner = accountId;
    }

    updateGoalControls();

    if (goalMode) {
        goalMode.onchange = updateGoalControls;
    }

    // =====================================
    // 4. 현재 목표 및 D-day 표시
    // =====================================

    // =====================================
    // ScorePath 21-308
    // 일반 전광판과 장기 목표 분리
    // =====================================

    // 일반 전광판은 목표 날짜와 관계없이
    // 학습 기록을 기반으로 다음 공부를 추천한다.
    //
    // 기존 목표 데이터는 삭제하지 않는다.
    // 시험 관련 날짜는 시험 모드에서 관리한다.

    const storedGoal = null;

    // =====================================
    // ScorePath 21-303: 목표일까지 시간 예산 표시
    // =====================================

    if (goalInfo) {

        if (!storedGoal?.targetDate) {

            goalInfo.textContent =
                "목표 미설정 · 오늘 공부 추천은 계속 이용할 수 있습니다.";

        } else {

            const status =
                resolveScorePathGeneralGoalV01({
                    mode: "date",
                    dateText: storedGoal.targetDate
                });

            if (!status.valid) {

                goalInfo.textContent =
                    "저장된 목표 날짜가 지났거나 올바르지 않습니다. " +
                    "새 목표를 설정해주세요.";

            } else {

                const average =
                    storedGoal.averageDailyMinutes;

                const hasAverage =
                    Number.isSafeInteger(average) &&
                    average >= 5 &&
                    average <= 1440;

                const dayLabel =
                    status.daysLeft === 0
                        ? "D-day"
                        : `D-${status.daysLeft}`;

                const formatDuration = (totalMinutes) =>
                    `${
                        Math.floor(totalMinutes / 60)
                            .toLocaleString("ko-KR")
                    }시간 ${totalMinutes % 60}분`;

                if (hasAverage) {

                    const weekDays =
                        Math.min(7, status.daysLeft);

                    goalInfo.textContent =
                        `목표 ${status.targetDate} · ${dayLabel} · ` +
                        `하루 평균 ${formatDuration(average)} · ` +
                        `향후 ${weekDays}일 예산 ${
                            formatDuration(average * weekDays)
                        } · ` +
                        `목표일까지 예산 ${
                            formatDuration(average * status.daysLeft)
                        }. ` +
                        "휴식일을 포함한 평균 기준 추정치로, " +
                        "실제 학습 필요량이나 추천 계획은 아닙니다.";

                } else {

                    goalInfo.textContent =
                        `목표 ${status.targetDate} · ${dayLabel} · ` +
                        "하루 평균 공부시간을 입력하면 " +
                        "기간별 예산을 볼 수 있습니다.";
                }
            }
        }
    }

    // =====================================
    // 5. 목표 저장
    // =====================================

    const saveGoalButton =
        board.querySelector("[data-general-goal-save]");

    if (saveGoalButton) {

        saveGoalButton.onclick = () => {

            const mode = goalMode?.value;
            const amount = goalAmount?.value ?? "";
            const unit = goalUnit?.value ?? "day";

            const result =
                resolveScorePathGeneralGoalV01({
                    mode,
                    dateText: goalDate?.value ?? "",
                    amountText: amount,
                    unit
                });

            if (!result.valid) {

                if (goalError) {
                    goalError.textContent = result.error;
                }

                return;
            }

            // =====================================
            // 평균 공부시간 검증
            // =====================================

            const hoursText =
                String(goalDailyHours?.value ?? "").trim();

            const minutesText =
                String(goalDailyMinutes?.value ?? "").trim();

            let averageDailyMinutes = null;

            // 평균은 선택사항.
            // 한쪽만 입력하면 다른 쪽은 0으로 계산한다.
            if (
                hoursText !== "" ||
                minutesText !== ""
            ) {

                const parsed =
                    parseScorePathDailyTimeV01(
                        hoursText || "0",
                        minutesText || "0"
                    );

                if (!parsed.valid) {

                    if (goalError) {
                        goalError.textContent = parsed.error;
                    }

                    return;
                }

                averageDailyMinutes =
                    parsed.totalMinutes;
            }

            // =====================================
            // 사용자별 목표 저장
            // =====================================

            try {

                localStorage.setItem(

                    goalStorageKey,

                    JSON.stringify({

                        targetDate:
                            result.targetDate,

                        mode,

                        amount:
                            mode === "period"
                                ? Number(amount)
                                : null,

                        unit:
                            mode === "period"
                                ? unit
                                : null,

                        averageDailyMinutes
                    })
                );

            } catch (error) {

                if (goalError) {
                    goalError.textContent =
                        "목표를 저장할 수 없습니다.";
                }

                return;
            }

            if (goalError) {
                goalError.textContent = "";
            }

            renderScorePathGeneralBoardV01();
        };
    }

    // =====================================
    // 6. 목표 해제
    // =====================================

    const clearGoalButton =
        board.querySelector(
            "[data-general-goal-clear]"
        );

    if (clearGoalButton) {

        clearGoalButton.onclick = () => {

            try {

                localStorage.removeItem(
                    goalStorageKey
                );

            } catch (error) {

                if (goalError) {

                    goalError.textContent =
                        "목표를 해제하지 못했습니다.";
                }

                return;
            }

            goalMode.dataset.owner = "";

            if (goalError) {
                goalError.textContent = "";
            }

            renderScorePathGeneralBoardV01();
        };
    }

    // =====================================
    // 3. 기록 부족 시 보조 추천
    // =====================================

    if (
        candidates.length === 0 &&
        topWeakness
    ) {

        candidates.push({

            type: "weakness",

            subject:
                topWeakness.subject || "",

            label:
                topWeakness.unit ||
                topWeakness.label ||
                topWeakness.weakConcept ||
                "취약 개념",

            minutes: 15,

            priority: 50,

            reason:
                "기존 기록에서 발견된 취약 개념입니다. " +
                "다만 현재 학습 근거가 제한적입니다."
        });
    }

    // =====================================
    // 4. 같은 공부 중복 추천 방지
    // =====================================

     // =====================================
    // ScorePath 21-284
    // 명시적으로 지정한 관련 단원 중복 완화
    // =====================================

    // =====================================
    // ScorePath 21-305
    // 중복 추천 근거 연결
    // =====================================

    const uniqueCandidates = [];
    const seenUnits = new Map();

    // 표기 차이만 정규화한다.
    // 다른 개념의 풀이 기록은 합치지 않는다.
    const normalizeLabel = (value) =>
        String(value || "")
            .normalize("NFKC")
            .replace(/\s+/g, "")
            .replace(/자릿수/g, "자리수")
            .toLowerCase();

    // 기존 제한된 명칭 대응 유지.
    // 개념 ID 도입 전까지는 완전한 중복 감지가 아니다.
    const mathAliases = new Map([
        ["덧셈", "기초덧셈"],
        ["한자리수의덧셈연산", "기초덧셈"],
        ["한자리수덧셈", "기초덧셈"]
    ]);

    for (const item of candidates) {

        const subjectKey =
            String(item.subject || "")
                .trim()
                .toLowerCase();

        let labelKey = normalizeLabel(item.label);

        if (subjectKey === "수학") {
            labelKey = mathAliases.get(labelKey) || labelKey;
        }

        const key = `${subjectKey}::${labelKey}`;
        const index = seenUnits.get(key);

        if (index !== undefined) {

            // 이미 선택된 높은 우선순위 근거는 유지한다.
            // 고유 문제 기록의 추가 근거는 버리지 않는다.
            const saved = uniqueCandidates[index];

            saved.evidenceSources =
                (saved.evidenceSources || 1) + 1;

            if (
                item.type === "learning_signal" &&
                item.nextAction
            ) {

                saved.nextAction = item.nextAction;

                saved.uniqueAttempts =
                    item.uniqueAttempts;

                saved.uniqueWrongCount =
                    item.uniqueWrongCount;
            }

            continue;
        }

        seenUnits.set(
            key,
            uniqueCandidates.length
        );

        uniqueCandidates.push({
            ...item,
            evidenceSources: 1
        });
    }

    // =====================================
    // 5. 공부 가능시간 배분
    // =====================================

    // =====================================
    // ScorePath 21-285
    // 시간 예산에 맞춘 단계적 학습 계획
    // =====================================

    let remainingMinutes = availableMinutes;
    const studyPlan = [];

    // 시간이 충분하면 후순위 후보도 최대 6개까지 검토한다.
    // 기록이 없는 공부를 억지로 만들어 채우지는 않는다.
    for (const item of uniqueCandidates.slice(0, 6)) {

        if (remainingMinutes < 5) break;

        const recommendedMinutes = Math.max(
            5,
            Math.round(Number(item.minutes) || 15)
        );

        const allocatedMinutes = Math.min(
            remainingMinutes,
            recommendedMinutes
        );

        studyPlan.push({ ...item, allocatedMinutes });
        remainingMinutes -= allocatedMinutes;
    }

    // 충분한 시간이 남은 경우, 상위 후보에 한해
    // 추가 문제풀이 시간을 제한적으로 배정한다.
    // 각 단원의 추가 시간은 기본 배정 시간 이하로 제한.
    if (remainingMinutes >= 5) {

        for (const item of studyPlan.slice(0, 3)) {

            if (remainingMinutes < 5) break;

            // 5분 단위로만 보충 배정한다.
            const extraCap =
                Math.floor(item.allocatedMinutes / 5) * 5;

            const extraMinutes = Math.min(
                remainingMinutes,
                extraCap
            );

            if (extraMinutes < 5) continue;

            item.allocatedMinutes += extraMinutes;
            remainingMinutes -= extraMinutes;

            item.reason +=
                " 추가 배정 시간에는 다른 문제로 이해도를 확인하세요.";
        }
    }

    // 추천 근거가 부족하면 남은 시간을 그대로 표시한다.
    // 공부시간은 상한이지 반드시 채워야 하는 목표가 아니다.
    if (remainingMinutes >= 5 && studyPlan.length) {

        studyPlan[0].reason +=
            ` 현재 ${remainingMinutes}분은 계획에 배정하지 않았습니다. ` +
            "추가 학습 기록을 확인한 뒤 계획을 다시 계산하세요.";
    }

    // =====================================
    // 6. 최우선 추천 선택
    // =====================================

    const selected =
        studyPlan[0] || null;

    let subject = "";
    let title = "";
    let reason = "";

    if (selected) {

        subject =
            selected.subject;

        title =
            `${subject} · ${selected.label}`;

        reason =
            selected.reason +
            ` 먼저 ${selected.allocatedMinutes}분 ` +
            "공부하는 것을 권장합니다.";

    } else {

        title =
            "학습 기록을 쌓아볼까요?";

        reason =
            "현재 추천할 학습 기록이 부족합니다. " +
            "과목을 선택하고 문제를 풀어보세요.";
    }

    // =====================================
    // 7. 오늘의 학습 계획 표시
    // =====================================

    const planBox =
        board.querySelector(
            "[data-general-plan]"
        );

    if (planBox) {

        const totalPlannedMinutes =
            studyPlan.reduce(
                (sum, item) =>
                    sum + item.allocatedMinutes,
                0
            );

        if (studyPlan.length === 0) {

            planBox.textContent =
                "학습 기록이 쌓이면 " +
                "오늘의 공부 계획을 추천합니다.";

        } else {

            planBox.innerHTML = `

                <strong>
                    📚 오늘의 추천 계획
                </strong>

                <p style="
                    margin:8px 0;
                    font-size:13px;
                    color:#64748b;
                ">
                    사용 가능 ${availableMinutes}분 중
                    초기 계획 ${totalPlannedMinutes}분
                </p>

                ${
                    studyPlan.map(
                        (item, index) => `

                            <div style="
                                display:flex;
                                align-items:center;
                                justify-content:space-between;
                                gap:12px;
                                padding:12px 0;
                                border-bottom:1px solid #e2e8f0;
                                flex-wrap:wrap;
                            ">

                                <!-- =====================
                                     추천 공부 정보
                                ===================== -->

                                <div style="
                                    flex:1;
                                    min-width:120px;
                                ">

                                    <strong style="
                                        display:block;
                                        margin-bottom:5px;
                                    ">
                                        ${index + 1}.
                                        ${escapeHtml(item.subject)}

                                        ·

                                        ${escapeHtml(item.label)}
                                    </strong>

                                    <small style="
                                        color:#64748b;
                                    ">
                                        권장 공부시간
                                        ${item.allocatedMinutes}분
                                    </small>

                                    <!-- =====================================
                                         ScorePath 21-312
                                         추천 근거 확인
                                    ===================================== -->

                                    <details style="
                                        margin-top:5px;
                                        font-size:12px;
                                    ">

                                        <summary style="
                                            cursor:pointer;
                                            color:#475569;
                                        ">
                                            추천 근거 보기
                                        </summary>

                                        <div style="
                                            white-space:pre-wrap;
                                            margin-top:5px;
                                            color:#475569;
                                        ">
                                            ${escapeHtml(
                                                item.reason ||
                                                "추가 학습 기록이 필요합니다."
                                            )}
                                        </div>

                                    </details>

                                </div>

                                <!-- =====================
                                     개별 공부 시작
                                ===================== -->

                                <button
                                    type="button"
                                    class="secondary-btn"
                                    data-general-plan-start="${index}"
                                    style="
                                        white-space:nowrap;
                                        padding:8px 12px;
                                    "
                                >
                                    📚 시작
                                </button>

                            </div>

                        `
                    ).join("")
                }

                <small style="
                    display:block;
                    margin-top:10px;
                    color:#64748b;
                ">
                    권장 시간은 초기 추정값입니다.
                    학습 효과를 검증한 시간은 아닙니다.
                </small>

            `;
        }
    }

    // =====================================
    // ScorePath 21-306
    // 추천에 필요한 실제 다음 행동과 목표 기간 맥락 표시
    // =====================================

    if (planBox && studyPlan.length) {

        const guide = document.createElement("div");

        guide.style.cssText =
            "margin-top:10px;padding:10px;background:#f8fafc;" +
            "border-radius:8px;font-size:12px;white-space:pre-line;" +
            "color:#334155;";

        const steps = studyPlan.slice(0, 3).map((item, index) => {

            const action = item.nextAction ||
                (item.type === "retry"
                    ? "기존 오답을 다시 풀어 틀린 원인을 확인하세요."
                    : "공부 후 새로운 문제로 이해도를 확인하세요.");

            return `${index + 1}. ${item.subject} · ${item.label}: ${action}`;
        });

        // 일반 모드 목표는 시험범위와 직접 연결된 데이터가 아니다.
        // 따라서 D-day만으로 우선순위를 임의 변경하지 않는다.
        const goalStatus = storedGoal?.targetDate
            ? resolveScorePathGeneralGoalV01({
                mode: "date",
                dateText: storedGoal.targetDate
            })
            : null;

        let horizon = "";

        if (goalStatus?.valid) {

            const average = storedGoal.averageDailyMinutes;

            if (
                Number.isSafeInteger(average) &&
                average >= 5 &&
                average <= 1440
            ) {

                const budget = goalStatus.daysLeft * average;

                const firstPass = uniqueCandidates.slice(0, 6).reduce(
                    (sum, candidate) =>
                        sum + Math.max(
                            5,
                            Math.round(Number(candidate.minutes) || 15)
                        ),
                    0
                );

                const deadlineLabel =
                    goalStatus.daysLeft === 0
                        ? "D-day"
                        : `D-${goalStatus.daysLeft}`;

                horizon =
                    `\n목표 ${deadlineLabel} · 추정 가용시간 ` +
                    `${Math.floor(budget / 60)}시간 ${budget % 60}분.`;

                if (budget < firstPass) {

                    horizon +=
                        ` 현재 상위 후보의 초기 권장시간 합계 ` +
                        `${firstPass}분보다 적습니다. ` +
                        "우선순위가 높은 공부부터 진행하세요.";
                }

                horizon +=
                    " 이 수치는 임시 시간 예산이지 실제 필요 공부시간이나 성적 향상 예측은 아닙니다.";

            } else {

                const deadlineLabel =
                    goalStatus.daysLeft === 0
                        ? "D-day"
                        : `D-${goalStatus.daysLeft}`;

                horizon =
                    `\n목표 ${deadlineLabel}. ` +
                    "하루 평균 시간을 설정하면 장기 가용시간을 확인할 수 있습니다.";
            }
        }

        guide.textContent =
            `📌 오늘의 다음 행동\n${steps.join("\n")}${horizon}`;

        planBox.appendChild(guide);
    }

    // =====================================
    // 전광판 내용 갱신
    // =====================================

    board.querySelector(
        "[data-general-date]"
    ).textContent =
        new Date().toLocaleDateString("ko-KR");

    board.querySelector(
        "[data-general-title]"
    ).textContent = title;

    board.querySelector(
        "[data-general-reason]"
    ).textContent = reason;

    // =====================================
    // 기존 문제풀이 기능 연결
    // =====================================

     // =====================================
    // ScorePath 21-264
    // 일반 전광판 공부 시작 연결
    // =====================================

    // =====================================
    // 1. 메인 공부 시작 버튼
    // =====================================

    const generalStartButton =
        board.querySelector(
            "[data-general-start]"
        );

    if (generalStartButton) {

        generalStartButton.onclick = () => {

            // 현재 가장 높은 우선순위 추천
            startScorePathGeneralStudyV01(
                selected
            );
        };
    }

    // =====================================
    // 2. 개별 공부 시작 버튼
    // =====================================

    const planStartButtons =
        board.querySelectorAll(
            "[data-general-plan-start]"
        );

    planStartButtons.forEach(
        (button) => {

            button.onclick = () => {

                const index =
                    Number(
                        button.dataset
                            .generalPlanStart
                    );

                // =====================================
                // 선택한 추천 확인
                // =====================================

                if (
                    !Number.isInteger(index) ||
                    index < 0 ||
                    index >= studyPlan.length
                ) {
                    return;
                }

                const recommendedStudy =
                    studyPlan[index];

                // =====================================
                // 해당 공부 시작
                // =====================================

                startScorePathGeneralStudyV01(
                    recommendedStudy
                );
            };
        }
    );

    // 시험 분석이 선택되면
    // 기존 시험 전광판을 사용
    board.hidden =
        Boolean(selectedExamState?.examId);
}


// =====================================
// 기존 대시보드 함수
// =====================================

function renderDashboard(dashboard) {
    dashboardState = dashboard;

    renderSubjects();

    const remainAi =
        Math.max(
            0,
            dashboard.planRule.aiDaily -
            dashboard.usageAi.count
        );

    const storageLimit =
        dashboard.planRule.storageLimit;

    // 문제 저장 개수는 정답(복습완료) + 오답 모두 합산한다.
    const savedProblemCount =
        (dashboard.wrongNotes?.length || 0) +
        (dashboard.solvedNotes?.length || 0);

    const storageText =
        storageLimit == null ||
        storageLimit === Infinity
            ? `${savedProblemCount}/무제한`
            : `${savedProblemCount}/${storageLimit}`;

    $("welcomeText").textContent =
        `${dashboard.user.name}님 / ${getPlanLabel(
            dashboard.user.plan
        )} 요금제`;

    $("usageText").textContent =
        `남은 AI 분석: ${remainAi} / 하루 제한: ${dashboard.planRule.aiDaily}`;

    const advancedUsage = dashboard.advancedUsage || {};
    $("advancedUsageText").textContent =
        advancedUsage.testUnlimited
            ? `응용문제 생성: ${advancedUsage.used || 0}회 (개발 테스트 · 제한 해제)`
            : `응용문제 생성: ${advancedUsage.used || 0}/${advancedUsage.limit || 0}회 · 남은 ${advancedUsage.remaining || 0}회`;

    $("slotText").textContent =
        `문제 저장: ${storageText}`;

    updatePlanLocks();

    // =====================================
    // 기존 오늘의 학습
    // =====================================

    renderTodayLearning();

    // =====================================
    // ScorePath 무료 학습 전광판 갱신
    // =====================================

    renderScorePathGeneralBoardV01();

    // =====================================
    // ScorePath 21-276
    // 새로고침 후 일반 공부 이어하기·취소 안내
    // =====================================

    renderScorePathGeneralResumeNoticeV01();


    // =====================================
    // ScorePath 21-342
    // 일반 모드 검증 진행률 실시간 갱신
    // =====================================

    const generalActive =
        dashboardState
            ?.generalStudySummary
            ?.activeStudy;

    const generalStatus =
        $("scorePathGeneralActiveStudyV01");

    if (
        generalActive?.id &&
        generalStatus
    ) {

        void api(
            "/api/scorepath/general-study/verification-progress"
        )

            .then(progress => {

                // 현재 학습 세션인지 확인
                if (
                    !progress.active ||

                    String(progress.sessionId) !==
                        String(generalActive.id) ||

                    String(
                        dashboardState
                            ?.generalStudySummary
                            ?.activeStudy
                            ?.id
                    ) !== String(generalActive.id)
                ) {

                    return;
                }

                const status =
                    $("scorePathGeneralActiveStudyV01");

                if (
                    !status ||
                    status !== generalStatus
                ) {

                    return;
                }

                const button =
                    status.querySelector(
                        "button.secondary-btn"
                    );

                const paragraphs =
                    status.querySelectorAll("p");

                const resultBox =
                    paragraphs[1];

                if (
                    !button ||
                    !resultBox
                ) {

                    return;
                }

                // 검증 개수
                const count =
                    Math.max(
                        0,
                        Math.min(
                            2,
                            Number(
                                progress.verificationCount
                            ) || 0
                        )
                    );

                const verifying =
                    progress.verificationStarted === true;

                // 검증 진행 상황 표시
                resultBox.textContent =
                    `검증 진행: ${count}/2개` +

                    (
                        count >= 2

                            ? " · 새 문제 확인 완료"

                            : ` · 새 문제 ${2 - count}개 더 필요`
                    );

                // 버튼 상태 갱신
                if (!button.disabled) {

                    button.textContent =
                        verifying

                            ? `🧪 검증 결과 확인 (${count}/2)`

                            : `✅ 공부 완료 (${count}/2)`;
                }

            })

            .catch(error => {

                // 진행률 조회 실패가
                // 기존 정답 저장을 취소하면 안 된다.
                console.warn(
                    "일반 검증 개수 조회 실패:",
                    error
                );
            });
    }

    // =====================================
    // ScorePath 21-137
    // 대시보드 갱신 중 화면 상태 보호
    // =====================================

    const shell =
        $("appShell");

    // 현재 로그인한 계정 구분
    const accountKey =
        String(
            dashboard?.user?.id ||
            dashboard?.user?.email ||
            "unknown"
        );

    const previousAccountKey =
        shell?.dataset.scorepathExamOwnerV01 || "";

    const accountChanged =
        previousAccountKey !== accountKey;

    // =====================================
    // 다른 계정으로 로그인한 경우
    // =====================================

    if (accountChanged && shell) {

        shell.dataset.scorepathExamOwnerV01 =
            accountKey;

        // 이전 계정의 시험 선택 정보 초기화
        scorePathLastExamV01 = null;

        selectedExamState = null;

        // 로그인 후 메뉴가 아직 없어도 홈을 표시
        setupScorePathMainNavigationV01();

        setScorePathMainNavigationV01(
            "home"
        );
    }

    // =====================================
    // 현재 화면 확인
    // =====================================

    const currentTab =
        document.documentElement.dataset
            .scorepathMainTab || "";

    // =====================================
    // 시험 목록이 필요한 상황에만 갱신
    // =====================================

    if (
        accountChanged ||

        !currentTab ||

        currentTab === "exams"
    ) {

        loadExamList();
    }

    // 홈·학습·오답 화면에서는
    // 현재 시험 분석 상태를 유지한다.

    // 기존 기능
    renderSummaryStats();
    renderSubjectStats();
    renderWrongList();
    renderSolvedList();
    renderTrashList();
    updateCounts();
    updateModeUI();

    // =====================================
    // ScorePath 21-118
    // 로그인 후 메인 메뉴 연결
    // =====================================

    setupScorePathMainNavigationV01();

    // =====================================
    // ScorePath 21-148
    // 계정별 최초 1회 학습 복원
    // =====================================

    const restoreShell =
        $("appShell");

    const restoreOwner =
        String(
            dashboardState?.user?.id ||
            dashboardState?.user?.email ||
            ""
        );

    // 같은 로그인 상태에서
    // 대시보드가 여러 번 갱신되더라도
    // 복원 API를 반복 호출하지 않는다.
    if (
        restoreShell &&
        restoreOwner &&

        restoreShell.dataset
            .scorepathRestoreOwnerV01 !==
            restoreOwner
    ) {

        restoreShell.dataset
            .scorepathRestoreOwnerV01 =
            restoreOwner;

        void restoreScorePathActiveStudyV01();
    }
}

// =====================================
// 진행 중인 학습 복원
// =====================================

async function restoreScorePathActiveStudyV01() {

    // 복원 요청 중복 방지
    if (
        restoreScorePathActiveStudyV01.busy ||
        !dashboardState ||
        $("appShell")?.hidden
    ) {
        return;
    }

    restoreScorePathActiveStudyV01.busy = true;

    const owner = String(
        dashboardState.user?.id ||
        dashboardState.user?.email ||
        ""
    );

    try {

        // 서버에서 실제 진행 중인 학습 조회
        const data = await api(
            "/api/scorepath/study/active"
        );

        // 로그아웃 또는 계정 변경 여부 확인
        if (
            $("appShell")?.hidden ||
            !dashboardState ||
            String(
                dashboardState.user?.id ||
                dashboardState.user?.email ||
                ""
            ) !== owner
        ) {
            return;
        }

        const session =
            data.active === true
                ? data.session
                : null;

        let button =
            $("scorePathStudyCompleteV01");

        // 진행 중인 학습이 없으면
        // 기존 완료 버튼 제거
        if (!session) {

            button?.remove();

            return;
        }

        if (
            !session.id ||
            !session.examId ||
            !session.unit
        ) {
            return;
        }

        // 완료 요청이 이미 진행 중이라면
        // 버튼 상태를 변경하지 않는다.
        if (
            button?.dataset.completePending ===
            "true"
        ) {
            return;
        }

        // =====================================
        // ScorePath 21-256
        // 진행 중인 시험·단원 복원 조건 수정
        // =====================================

        const needsContextRestore =

            String(
                $("scorePathExam")?.value || ""
            ) !== String(session.examId) ||

            String(
                $("scorePathUnit")?.value || ""
            ) !== String(session.unit);

        // =====================================
        // 공부 완료 버튼 복원
        // =====================================

        if (!button) {

            const title =
                $("cardInput")?.querySelector("h2");

            if (!title) return;

            button =
                document.createElement("button");

            button.id =
                "scorePathStudyCompleteV01";

            button.type =
                "button";

            button.className =
                "secondary-btn";

            button.style.margin =
                "0 0 14px";

            title.insertAdjacentElement(
                "afterend",
                button
            );
        }

        // =====================================
        // 시험과 단원 선택 복원
        // =====================================

        if (needsContextRestore) {

            try {

                const examData =
                    await api("/api/exams");

                if (
                    !dashboardState ||
                    $("appShell")?.hidden ||
                    String(
                        dashboardState.user?.id ||
                        dashboardState.user?.email ||
                        ""
                    ) !== owner
                ) {
                    return;
                }

                renderScorePathContext(
                    examData.exams || []
                );

                const examSelect =
                    $("scorePathExam");

                const unitSelect =
                    $("scorePathUnit");

                if (
                    examSelect &&
                    [...examSelect.options].some(
                        (option) =>
                            option.value ===
                            String(session.examId)
                    )
                ) {

                    examSelect.value =
                        String(session.examId);

                    examSelect.dispatchEvent(
                        new Event("change")
                    );

                    if (
                        unitSelect &&
                        [...unitSelect.options].some(
                            (option) =>
                                option.value ===
                                session.unit
                        )
                    ) {

                        unitSelect.value =
                            session.unit;
                    }
                }

            } catch (error) {

                // 시험 선택 복원에 실패해도
                // 공부 완료 버튼은 유지한다.
                console.warn(
                    "학습 범위 복원 실패:",
                    error
                );
            }
        }

        button.dataset.sessionId =
            String(session.id);

        button.disabled = false;

        button.textContent =
            `✅ ${session.unit} 공부 완료`;

        // =====================================
        // 실제 학습 완료
        // =====================================

        button.onclick = async () => {

            if (button.disabled) return;

            // =====================================
            // ScorePath 21-257
            // 복원된 학습의 시험·단원 일치 확인
            // =====================================

            if (

                String(
                    $("scorePathExam")?.value || ""
                ) !== String(session.examId) ||

                String(
                    $("scorePathUnit")?.value || ""
                ) !== String(session.unit)

            ) {

                alert(
                    "현재 선택한 시험·단원이 " +
                    "진행 중인 학습과 다릅니다. " +
                    "학습 범위를 다시 확인해 주세요."
                );

                return;
            }

            if (
                !confirm(
                    `${session.unit} 공부를 완료할까요?`
                )
            ) {
                return;
            }

            button.disabled = true;

            button.dataset.completePending =
                "true";

            let saved = false;

            try {

                const result = await api(
                    "/api/scorepath/study/complete",
                    "POST",
                    {
                        examId:
                            session.examId,

                        unit:
                            session.unit,

                        sessionId:
                            session.id
                    }
                );

                saved = true;

                button.remove();

                const next =
                    result.session
                        ?.recommendationAfterComplete;

                alert(
                    `✅ 공부 완료 기록 저장!\n` +
                    `다음 추천: ${
                        next
                            ? next.unit +
                              " · " +
                              next.minutes +
                              "분"

                            : "현재 추천 없음"
                    }`
                );

                // 최신 전광판 다시 계산
                const opened =
                    await openExamRisk(
                        session.examId
                    );

                if (opened === false) {

                    alert(
                        "완료 기록은 저장됐지만 " +
                        "전광판 갱신에 실패했습니다."
                    );

                } else {

                    document.querySelector(
                        '#scorePathExamTabsV01 ' +
                        '[data-scorepath-tab="recommend"]'
                    )?.click();
                }

            } catch (error) {

                // =====================================
                // ScorePath 21-328
                // 복원된 학습의 검증 단계 안내
                // =====================================

                if (
                    !saved &&
                    error.data?.verificationRequired === true
                ) {

                    const checked = Math.max(
                        0,
                        Number(
                            error.data.newUniqueAttempts
                        ) || 0
                    );

                    const remaining = Math.max(
                        0,
                        Number(
                            error.data.remainingProblems
                        ) || 0
                    );

                    button.textContent =
                        `🧪 검증 결과 확인 (${checked}/3)`;

                    alert(
                        `학습 후 확인 단계입니다.\n` +
                        `새 문제 ${checked}/3개 확인됨.\n` +
                        `새로운 문제 ${remaining}개를 더 풀고 ` +
                        `이 버튼을 다시 눌러주세요.`
                    );

                    if (button.isConnected) {
                        button.disabled = false;
                    }

                    return;
                }

                alert(
                    (
                        saved
                            ? "완료 기록은 저장됐지만 화면 갱신에 실패했습니다. "
                            : "공부 완료에 실패했습니다. "
                    ) +
                    (
                        error.message ||
                        "다시 확인해 주세요."
                    )
                );

                if (
                    !saved &&
                    button.isConnected
                ) {
                    button.disabled = false;
                }

            } finally {

                delete button.dataset.completePending;
            }
        };

        // =====================================
        // ScorePath 21-339
        // 새로고침 후 시험 모드 자동 복원
        // =====================================

        // 진행 중인 시험 공부가 있다면
        // 이전에 선택한 시험 전광판을 복원한다.
        //
        // 학습 세션은 새로 생성하지 않는다.

        if (
            String(selectedExamState?.examId || "") !==
                String(session.examId) ||

            $("examRiskView")?.hidden === true
        ) {

            const reopened =
                await openExamRisk(
                    session.examId
                );

            if (reopened !== true) {

                console.warn(
                    "진행 중인 시험 화면 복원 실패:",
                    session.examId
                );
            }
        }

        // 정상적으로 시험이 복원됐다면
        // 일반 전광판 대신 시험 홈을 표시한다.

        if (
            String(selectedExamState?.examId || "") ===
                String(session.examId)
        ) {

            setScorePathMainNavigationV01(
                "home"
            );
        }

    } catch (error) {

        console.error(
            "SCOREPATH STUDY RESTORE ERROR:",
            error
        );

    } finally {

        restoreScorePathActiveStudyV01.busy =
            false;
    }
}


// =====================================
// 7단계 - 시험 모드
// 시험 목록 + D-Day + 위험도
// =====================================

let selectedExamState = null;


async function loadExamList() {
    const examList =
        $("examList");

    if (!examList) {
        return;
    }


    // =====================================
    // ScorePath 시험 등록 버튼
    // =====================================

    const createExamBtn =
        $("createExamBtn");

    if (
        createExamBtn &&
        !createExamBtn.dataset.bound
    ) {
        createExamBtn.dataset.bound = "true";

        createExamBtn.addEventListener(
            "click",
            async () => {

                const messageBox =
                    $("createExamMessage");


                // =====================================
                // 입력값 가져오기
                // =====================================

                const name =
                    $("examName")
                        ?.value
                        ?.trim() || "";

                const subject =
                    $("examSubject")
                        ?.value
                        ?.trim() || "";

                const examDate =
                    $("examDate")
                        ?.value || "";

                const targetScore =
                    Number(
                        $("examTargetScore")
                            ?.value
                    );

                const dailyStudyMinutes =
                    Number(
                        $("examDailyStudyMinutes")
                            ?.value
                    );


                // 시험 범위:
                // 한 줄 = 한 단원/개념
                const examRange =
                    (
                        $("examRange")
                            ?.value || ""
                    )
                        .split("\n")
                        .map(
                            (item) =>
                                item.trim()
                        )
                        .filter(Boolean);


                // =====================================
                // 프론트 기본 검증
                // =====================================

                if (!name) {
                    messageBox.textContent =
                        "시험 이름을 입력해주세요.";

                    return;
                }


                if (!subject) {
                    messageBox.textContent =
                        "과목을 선택해주세요.";

                    return;
                }


                if (!examDate) {
                    messageBox.textContent =
                        "시험 날짜를 선택해주세요.";

                    return;
                }


                if (
                    !Number.isFinite(
                        targetScore
                    ) ||
                    targetScore < 0 ||
                    targetScore > 100
                ) {
                    messageBox.textContent =
                        "목표 점수는 0~100점 사이로 입력해주세요.";

                    return;
                }


                if (
                    !Number.isFinite(
                        dailyStudyMinutes
                    ) ||
                    dailyStudyMinutes <= 0 ||
                    dailyStudyMinutes > 1440
                ) {
                    messageBox.textContent =
                        "하루 공부 가능 시간을 확인해주세요.";

                    return;
                }


                if (
                    examRange.length === 0
                ) {
                    messageBox.textContent =
                        "시험 범위를 하나 이상 입력해주세요.";

                    return;
                }


                // =====================================
                // 등록 시작
                // =====================================

                createExamBtn.disabled = true;

                messageBox.textContent =
                    "시험을 등록하는 중...";


                 try {

                    // =====================================
                    // ScorePath V1
                    // 현재 성적 처리
                    // =====================================

                    const currentScoreText =
                        $("examCurrentScore")
                            ?.value
                            ?.trim() ?? "";

                    const currentScore =
                        currentScoreText === ""
                            ? null
                            : Number(currentScoreText);

                    // 현재 성적 검증
                    if (
                        currentScore !== null &&
                        (
                            !Number.isFinite(currentScore) ||
                            currentScore < 0 ||
                            currentScore > 100
                        )
                    ) {

                        throw new Error(
                            "현재 성적은 0~100점으로 입력해 주세요."
                        );
                    }

                    // =====================================
                    // 시험 등록
                    // =====================================

                    const registered = await api(
                        "/api/exams",
                        "POST",
                        {
                            name,
                            subject,
                            examDate,

                            currentScore,
                            targetScore,

                            dailyStudyMinutes,
                            examRange
                        }
                    );

                    // =====================================
                    // ScorePath 21-225
                    // 시험 등록 후 첫 추천 자동 표시
                    // =====================================

                    // 등록 성공 → 입력창 초기화
                    $("examName").value = "";
                    $("examSubject").value = "";
                    $("examDate").value = "";

                    $("examCurrentScore").value = "";
                    $("examTargetScore").value = "";

                    $("examDailyStudyMinutes").value = "";
                    $("examRange").value = "";

                    messageBox.textContent =
                        "시험이 등록되었습니다.";

                    // 신규 시험 목록과 선택기 갱신
                    await loadExamList();

                    // 방금 등록한 시험의 정확한 ID 사용
                    const createdExamId =
                        registered?.exam?.id;

                    if (createdExamId) {

                        const opened =
                            await openExamRisk(
                                createdExamId
                            );

                        if (!opened) {

                            messageBox.textContent =
                                "시험은 저장됐지만 " +
                                "추천 화면을 열지 못했습니다. " +
                                "시험 목록에서 다시 열어 주세요.";
                        }

                    } else {

                        messageBox.textContent =
                            "시험 등록 응답에 ID가 없습니다. " +
                            "시험 목록에서 등록 결과를 확인해 주세요.";
                    }


                } catch (error) {

                    console.error(
                        "EXAM CREATE ERROR:",
                        error
                    );

                    messageBox.textContent =
                        error.message ||
                        "시험을 등록하지 못했습니다.";

                } finally {

                    createExamBtn.disabled =
                        false;
                }
            }
        );
    }


    // =====================================
    // 기존 시험 목록 로딩
    // =====================================

    $("examListView").hidden =
        false;

    $("examRiskView").hidden =
        true;

    $("examStudyView").hidden =
        true;

        $("examResultView").hidden =
        true;

    // =====================================
    // ScorePath 시험 모드 상태 보호
    // =====================================

    // 시험 목록을 조회한다는 이유만으로
    // 현재 선택한 시험을 초기화하지 않는다.
    //
    // 시험 모드 해제는 사용자가
    // OFF 버튼을 눌렀을 때 처리한다.

    examList.innerHTML = `
        <div class="problem-item">
            <div class="problem-item-text">
                시험 정보를 불러오는 중...
            </div>
        </div>
    `;


    try {

        const data =
            await api(
                "/api/exams"
            );


        const exams =
            Array.isArray(
                data.exams
            )
                ? data.exams
                : [];


        renderExamList(
    exams
);

// =====================================
// ScorePath - 문제 입력 시험/범위 선택기
// =====================================

renderScorePathContext(
    exams
);


    } catch (error) {

        console.error(
            "EXAM LIST LOAD ERROR:",
            error
        );


        examList.innerHTML = `
            <div class="problem-item">

                <div class="problem-item-text">

                    ${escapeHtml(
                        error.message ||
                        "시험 정보를 불러오지 못했습니다."
                    )}

                </div>

            </div>
        `;
    }
}

// =====================================
// ScorePath - 문제 입력 시험/범위 선택기
// =====================================

function renderScorePathContext(exams) {

    const examSelect =
        $("scorePathExam");

    const unitSelect =
        $("scorePathUnit");

    const messageBox =
        $("scorePathContextMessage");


    if (
        !examSelect ||
        !unitSelect
    ) {
        return;
    }


    const examList =
        Array.isArray(exams)
            ? exams
            : [];


    // 기존 선택값 유지
    const currentExamId =
        examSelect.value || "";

    const currentUnit =
        unitSelect.value || "";


    // =====================================
    // 시험 목록
    // =====================================

    examSelect.innerHTML =
        `<option value="">시험 연결 안 함</option>`;


    examList.forEach((exam) => {

        const option =
            document.createElement("option");

        option.value =
            exam.id || "";

        option.textContent =
            `${exam.name || "이름 없는 시험"} · ${exam.subject || "과목 미지정"}`;

        examSelect.appendChild(
            option
        );
    });


    if (
        examList.some(
            (exam) =>
                String(exam.id) ===
                String(currentExamId)
        )
    ) {
        examSelect.value =
            currentExamId;
    }


    // =====================================
    // 선택된 시험에 맞춰 범위 표시
    // =====================================

    function updateUnitSelect() {

        const selectedExamId =
            examSelect.value;


        const selectedExam =
            examList.find(
                (exam) =>
                    String(exam.id) ===
                    String(selectedExamId)
            );

        // =====================================
        // ScorePath 21-261
        // 일반 / 시험 단원 입력 구분
        // =====================================

        const generalUnitWrap =
            $("scorePathGeneralUnitWrap");

        const examModeActive =
            Boolean(selectedExam);

        // =====================================
        // ScorePath 21-277
        // 시험 선택 시 과목 변경 방지
        // =====================================

        const subjectSelect =
            $("subject");

        if (subjectSelect) {

            // 시험이 선택되어 있다면
            // 해당 시험의 과목만 사용한다.
            if (examModeActive) {

                const examSubject =
                    String(
                        selectedExam.subject || ""
                    ).trim();

                subjectSelect.value =
                    examSubject;

                // 다른 과목으로 변경 방지
                subjectSelect.disabled =
                    true;

                subjectSelect.title =
                    "시험에 등록된 과목으로 고정됩니다. " +
                    "다른 과목을 공부하려면 시험을 변경하세요.";

            } else {

                // 일반 모드로 돌아오면
                // 과목을 자유롭게 선택할 수 있다.
                subjectSelect.disabled =
                    false;

                subjectSelect.title =
                    "";
            }
        }

        // =====================================
        // 1. 일반 모드
        // =====================================

        if (!examModeActive) {

            // 일반 단원 입력창 표시
            if (generalUnitWrap) {

                generalUnitWrap.hidden = false;

                generalUnitWrap.style.display = "";
            }

        }

        // =====================================
        // 2. 시험 모드
        // =====================================

        else {

            // 일반 단원 입력창 숨기기
            if (generalUnitWrap) {

                generalUnitWrap.hidden = true;

                generalUnitWrap.style.display = "none";
            }

            // 기존 시험 과목 자동 변경
            const subjectSelect =
                $("subject");

            if (subjectSelect) {

                subjectSelect.value =
                    selectedExam.subject || "";
            }
        }

        // =====================================
        // 기존 시험 단원 선택기 유지
        // =====================================

        unitSelect.innerHTML = "";


        // 시험 연결 안 함
        if (!selectedExam) {

            unitSelect.disabled =
                true;

            unitSelect.innerHTML = `
                <option value="">
                    시험을 먼저 선택하세요
                </option>
            `;

            if (messageBox) {
                messageBox.textContent =
                    "시험을 연결하면 풀이 기록이 시험 범위별로 저장됩니다.";
            }

            return;
        }


        const ranges =
            Array.isArray(
                selectedExam.examRange
            )
                ? selectedExam.examRange
                : [];


        unitSelect.disabled =
            false;


        unitSelect.innerHTML = `
            <option value="">
                학습 범위 선택
            </option>
        `;


        ranges.forEach((range) => {

            const option =
                document.createElement("option");

            option.value =
                range;

            option.textContent =
                range;

            unitSelect.appendChild(
                option
            );
        });


        // 기존 단원이 아직 같은 시험에 존재하면 유지
        if (
            ranges.includes(
                currentUnit
            )
        ) {
            unitSelect.value =
                currentUnit;
        }


        if (messageBox) {

            messageBox.textContent =
                ranges.length > 0
                    ? `${selectedExam.name}의 시험 범위를 선택하세요.`
                    : "이 시험에는 등록된 시험 범위가 없습니다.";
        }
    }


    // 중복 이벤트 방지
    examSelect.onchange =
        updateUnitSelect;


    updateUnitSelect();
}

function renderExamList(exams) {
    const examList =
        $("examList");

    if (!examList) {
        return;
    }

    examList.innerHTML = "";

    if (exams.length === 0) {
        examList.innerHTML = `
            <div class="problem-item">
                <div class="problem-item-text">
                    등록된 시험이 없습니다.
                </div>
            </div>
        `;

        return;
    }

    exams.forEach((exam) => {
        const div =
            document.createElement("div");

        div.className =
            "problem-item";

        const dDay =
            Number.isFinite(
                Number(exam.daysLeft)
            )
                ? Number(exam.daysLeft)
                : null;

        let dDayText =
            "날짜 정보 없음";

        if (dDay !== null) {
            if (dDay === 0) {
                dDayText = "D-DAY";
            } else if (dDay > 0) {
                dDayText =
                    `D-${dDay}`;
            } else {
                dDayText =
                    `D+${Math.abs(dDay)}`;
            }
        }

        div.innerHTML = `
            <div class="problem-item-title">
                ${escapeHtml(
                    exam.name ||
                    "이름 없는 시험"
                )}
            </div>

            <div class="problem-item-text">
                ${escapeHtml(
                    exam.subject ||
                    "과목 미지정"
                )}
            </div>

            <div class="check-text">
                ${escapeHtml(dDayText)}
                ${
                    exam.examDate
                        ? ` · ${escapeHtml(
                            exam.examDate
                        )}`
                        : ""
                }
            </div>

            <div class="button-row">
                <button
                    type="button"
                    class="secondary-btn"
                    data-exam-risk="${escapeHtml(
                        exam.id || ""
                    )}"
                >
                    시험 대비 분석
                </button>
            </div>
        `;

        examList.appendChild(div);
    });

    examList
        .querySelectorAll(
            "[data-exam-risk]"
        )
        .forEach((button) => {
            button.addEventListener(
                "click",
                () => {
                    openExamRisk(
                        button.dataset.examRisk
                    );
                }
            );
        });
}


async function openExamRisk(examId) {
    if (!examId) {
        return;
    }

    const messageBox =
        $("examModeMessage");

    messageBox.textContent =
        "시험 데이터를 분석하는 중...";

    try {
        const data =
            await api("/api/exams");

        const exams =
            Array.isArray(data.exams)
                ? data.exams
                : [];

        const exam =
            exams.find(
                (item) =>
                    String(item.id) ===
                    String(examId)
            );

        if (!exam) {
            throw new Error(
                "선택한 시험을 찾을 수 없습니다."
            );
        }

        const riskProfile =
            exam.riskProfile || {};

        const rangeStatus =
            exam.rangeStatus || {
                totalRangeCount: 0,
                measuredCount: 0,
                insufficientCount: 0,
                unmeasuredCount: 0,
                diagnosisRequiredCount: 0,
                ranges: []
            };

        // =====================================
        // ScorePath V1
        // 시험 모드와 문제풀이 자동 연결
        // =====================================

        selectedExamState = {
            examId: exam.id,
            exam,
            riskProfile,
            rangeStatus
        };

        // =====================================
        // 문제 입력창에 현재 시험 연결
        // =====================================

        const problemExamSelect =
            $("scorePathExam");

        if (problemExamSelect) {

            const targetExamId =
                String(exam.id);

            const examExists =
                [...problemExamSelect.options]
                    .some(
                        option =>
                            String(option.value) ===
                            targetExamId
                    );

            if (
                examExists &&
                problemExamSelect.value !== targetExamId
            ) {

                problemExamSelect.value =
                    targetExamId;

                // 기존 시험/단원 선택기 갱신
                problemExamSelect.dispatchEvent(
                    new Event("change")
                );
            }
        }

        // =====================================
        // 기존 시험 전광판 출력
        // =====================================

        renderExamRisk(
            exam,
            riskProfile,
            rangeStatus,
            exam.unitStats || []
        );

        // =====================================
        // ScorePath 21-119
        // 현재 전광판과 메인 메뉴 연결
        // =====================================

        scorePathLastExamV01 = {

            examId:
                String(exam.id),

            account:
                dashboardState?.user?.id ||
                dashboardState?.user?.email ||
                ""
        };

        setScorePathMainNavigationV01(
            "home"
        );

        messageBox.textContent = "";

        // =====================================
        // ScorePath 21-142
        // 전광판 로딩 성공
        // =====================================

        return true;

    } catch (error) {

        console.error(
            "EXAM RISK LOAD ERROR:",
            error
        );

        // =====================================
        // 실패한 시험의 임시 상태 초기화
        // =====================================

        if (
            String(scorePathLastExamV01?.examId) ===
            String(examId)
        ) {
            scorePathLastExamV01 = null;
        }

        if (
            String(selectedExamState?.examId) ===
            String(examId)
        ) {
            selectedExamState = null;
        }

        // 이전 전광판이 남아 보이지 않도록 처리
        $("examRiskView").hidden = true;

        messageBox.textContent =
            error.message ||
            "시험 분석 데이터를 불러오지 못했습니다.";

        // 로딩 실패
        return false;
    }
}


// =====================================
// ScorePath 21-28
// 누적 학습 기록 화면
// =====================================

async function loadScorePathStudyHistory(examId) {

    const summaryBox =
        $("examRiskSummary");

    if (!summaryBox) return;

    const historyBox =
        document.createElement("div");

    historyBox.className =
        "problem-item";

    historyBox.style.marginTop =
        "12px";

    historyBox.textContent =
        "📈 학습 기록을 불러오는 중...";

    summaryBox.appendChild(historyBox);

    try {

        const data = await api(
            `/api/scorepath/study/history?examId=${encodeURIComponent(examId)}`
        );

        // 다른 시험 화면으로 이동했다면 표시하지 않음
        if (
            !historyBox.isConnected ||
            String(selectedExamState?.examId) !== String(examId)
        ) {
            return;
        }

        const summary =
            data.summary || {};

        const units =
            Array.isArray(data.unitStats)
                ? data.unitStats
                : [];

        const studiedUnits = units.filter(
            (item) => Number(item.completedSessions) > 0
        );

                // =====================================
        // ScorePath 21-31
        // 단원별 정답률 변화 표시
        // =====================================

        // ScorePath 21-34: 단원별 학습 기록 + 재진단
        const unitHtml = studiedUnits.map((item, index) => {
            let changeText = "비교할 학습 기록이 부족합니다.";

            if (item.accuracyChange != null) {
                const change = Number(item.accuracyChange);
                changeText =
                    `최근 두 학습 회차: ${item.previousAccuracy}% → ` +
                    `${item.recentAccuracy}% ` +
                    `(${change > 0 ? "+" : ""}${change}%p)`;
            }

            const diagnosis = item.diagnosisComparison || {};
            let diagnosisText = "학습 전후 진단 기록이 부족합니다.";

            if (diagnosis.status === "comparable") {
                const change = Number(diagnosis.changePp);
                diagnosisText =
                    `진단 정답률(참고): ${diagnosis.beforeAccuracy}% → ` +
                    `${diagnosis.afterAccuracy}% ` +
                    `(${change > 0 ? "+" : ""}${change}%p)`;
            } else if (diagnosis.status === "not_comparable") {
                diagnosisText = "진단 문항 조건이 달라 직접 비교하지 않았습니다.";
            }

            return `
                <div class="problem-item" style="margin-top:8px;">
                    <div class="problem-item-title">
                        ${escapeHtml(item.unit)}
                    </div>
                    <div class="check-text">
                        완료: ${Number(item.completedSessions) || 0}회
                        · 경과시간: ${Number(item.totalMinutes) || 0}분
                    </div>
                    <div class="check-text">
                        풀이: ${Number(item.attempts) || 0}문제
                        · 누적 정답률: ${
                            item.accuracy == null
                                ? "측정 불가"
                                : `${Number(item.accuracy)}%`
                        }
                    </div>
                    <div class="check-text">
                        📊 ${escapeHtml(changeText)}
                    </div>
                    <div class="check-text" style="margin-top:8px;">
                        🎯 ${escapeHtml(diagnosisText)}
                    </div>
                    <button
                        type="button"
                        class="secondary-btn"
                        data-rediagnose-index="${index}"
                        style="margin-top:8px;"
                    >
                        다시 진단하기
                    </button>
                </div>
            `;
        }).join("");

        historyBox.innerHTML = `
            <div class="problem-item-title">
                📈 누적 학습 기록
            </div>

            <div class="check-text">
                완료한 학습: ${Number(summary.completedSessions) || 0}회
            </div>

            <div class="check-text">
                총 경과시간: ${Number(summary.totalMinutes) || 0}분
            </div>

            <div class="check-text">
                풀이 문제: ${Number(summary.totalAttempts) || 0}개
            </div>

            <div class="check-text">
                정답: ${Number(summary.totalCorrect) || 0}개
                · 오답: ${Number(summary.totalWrong) || 0}개
            </div>

            <div class="check-text">
                누적 정답률: ${
                    summary.accuracy == null
                        ? "측정 불가"
                        : `${Number(summary.accuracy)}%`
                }
            </div>

            <div class="problem-item-title" style="margin-top:12px;">
                단원별 학습 기록
            </div>

                        ${unitHtml || '<div class="check-text">아직 완료한 학습이 없습니다.</div>'}

            <div
                class="problem-item-title"
                style="margin-top:16px;"
            >
                🕒 최근 완료한 학습
            </div>

            ${
                (
                    Array.isArray(data.sessions)
                        ? data.sessions.slice(0, 3)
                        : []
                ).map((session) => {

                    const results =
                        session.results || {};

                    const accuracy =
                        results.accuracy == null
                            ? "측정 불가"
                            : `${Number(results.accuracy)}%`;

                    const completedDate =
                        session.completedAt
                            ? new Date(
                                session.completedAt
                            ).toLocaleString("ko-KR")
                            : "-";

                    return `
                        <div
                            class="check-text"
                            style="margin-top:8px;"
                        >
                            ${escapeHtml(session.unit)}
                            · ${Number(session.actualMinutes) || 0}분
                            · ${Number(results.attempts) || 0}문제
                                                       · 정답률 ${accuracy}
                            · 새 고유문제 ${Number(results.newUniqueAttempts) || 0}개

                            <div style="margin-top:4px;">
                                ${
                                    results.estimatedMasteryChangePp == null
                                        ? "추정 숙련도 변화: 비교 근거 부족"
                                        : `추정 숙련도 ${Number(results.estimatedMasteryBefore)}% → ` +
                                          `${Number(results.estimatedMasteryAfter)}% ` +
                                          `(${Number(results.estimatedMasteryChangePp) > 0 ? "+" : ""}` +
                                          `${Number(results.estimatedMasteryChangePp)}%p, 참고용)`
                                }
                            </div>

                            <div>
                                ${escapeHtml(completedDate)}
                            </div>
                        </div>
                    `;
                }).join("") ||
                '<div class="check-text">완료한 학습이 없습니다.</div>'
            }
        `;

        // ScorePath 21-35: 다시 진단하기 버튼 연결
        historyBox
            .querySelectorAll("[data-rediagnose-index]")
            .forEach((button) => {
                button.addEventListener("click", () => {
                    const index = Number(button.dataset.rediagnoseIndex);
                    const unit = studiedUnits[index]?.unit;
                    if (!unit) return;

                    const confirmed = confirm(
                        `${unit} 단원을 다시 진단할까요?\n\n` +
                        "새 진단 문제 생성 시 AI API 비용이 발생할 수 있습니다."
                    );
                    if (!confirmed) return;

                    startExamDiagnosis(unit);
                });
            });

    } catch (error) {

        if (historyBox.isConnected) {
            historyBox.textContent =
                error.message ||
                "학습 기록을 불러오지 못했습니다.";
        }
    }
}


// =====================================
// ScorePath 21-45
// 진행 중인 학습 상태 복원
// =====================================

async function refreshScorePathActiveStudy(
    examId,
    studySessions
) {
    const box = $("examRiskSummary");

    if (!box) return;

    try {
        const data = await api(
            "/api/scorepath/study/active"
        );

        // 다른 시험으로 이동한 경우 화면 변경 방지
        if (
            $("examRiskView").hidden ||
            String(selectedExamState?.examId) !== String(examId)
        ) {
            return;
        }

        const active =
            data.active === true
                ? data.session
                : null;

        // =====================================
        // ScorePath 21-255
        // 취소·완료된 학습의 버튼 정리
        // =====================================

        if (!active) {

            $("scorePathStudyCompleteV01")
                ?.remove();
        }

        // 기존 상태 표시 제거
        box.querySelector(
            "[data-active-study-status]"
        )?.remove();

        const status = document.createElement("div");

        status.className = "check-text";

        status.dataset.activeStudyStatus = "true";

        status.style.marginTop = "12px";

        if (active) {
            const sameExam =
                String(active.examId) === String(examId);

            const elapsed =
                Number(active.elapsedMinutes) || 0;

            status.textContent = sameExam
                ? `📖 진행 중: ${active.unit} · 경과 ${elapsed}분`
                : `📖 다른 시험의 "${active.unit}" 학습이 진행 중입니다.`;
        } else {
            status.textContent =
                "현재 진행 중인 학습이 없습니다.";
        }

                box.appendChild(status);

        // =====================================
        // ScorePath 21-49
        // 진행 중인 학습 취소 버튼
        // =====================================

        if (active) {

            const cancelButton =
                document.createElement("button");

            cancelButton.type = "button";

            cancelButton.className =
                "secondary-btn";

            cancelButton.textContent =
                "학습 취소";

            cancelButton.style.marginLeft =
                "10px";

                        cancelButton.dataset.studyCancel =
                active.id;

            status.appendChild(cancelButton);

            // =====================================
            // ScorePath 21-50
            // 학습 취소 API 연결
            // =====================================

            cancelButton.addEventListener(
                "click",
                async () => {

                    const confirmed = confirm(
                        `"${active.unit}" 학습을 취소할까요?\n\n` +
                        "취소한 학습은 완료 기록에 포함되지 않습니다."
                    );

                    if (!confirmed) return;

                    cancelButton.disabled = true;

                    try {

                        await api(
                            "/api/scorepath/study/cancel",
                            "POST",
                            {
                                sessionId: active.id
                            }
                        );

                        alert("학습이 취소되었습니다.");

                        // 현재 화면의 상태 복원
                        await refreshScorePathActiveStudy(
                            examId,
                            studySessions
                        );

                    } catch (error) {

                        alert(
                            error.message ||
                            "학습을 취소하지 못했습니다."
                        );

                        cancelButton.disabled = false;
                    }
                }
            );
        }

        // 공부 시작 버튼 상태
        box.querySelectorAll("[data-study-start]")
            .forEach((button) => {

                const index =
                    Number(button.dataset.studyStart);

                const session =
                    studySessions[index];

                if (!session) return;

                const isCurrent =
                    active &&
                    String(active.examId) === String(examId) &&
                    active.unit === session.unit;

                button.disabled = Boolean(active);

                button.textContent = isCurrent
                    ? "공부 진행 중"
                    : "공부 시작";
            });

        // 공부 완료 버튼 상태
        box.querySelectorAll("[data-study-complete]")
            .forEach((button) => {

                const index =
                    Number(button.dataset.studyComplete);

                const session =
                    studySessions[index];

                if (!session) return;

                button.disabled = !(
                    active &&
                    String(active.examId) === String(examId) &&
                    active.unit === session.unit
                );
            });

    } catch (error) {

        console.error(
            "SCOREPATH ACTIVE STUDY ERROR:",
            error
        );
    }
}


// =====================================
// ScorePath 21-114
// 전광판 내부 3탭
// 추천 / 학습 / 상세
// =====================================

let scorePathExamTabV01 = "recommend";

function setupScorePathExamTabsV01() {

    const summary =
        $("examRiskSummary");

    const details =
        $("examRiskWeaknesses");

    const view =
        $("examRiskView");

    if (!summary || !details || !view) {
        return;
    }

    let nav =
        $("scorePathExamTabsV01");

    // =====================================
    // 탭 버튼 생성
    // =====================================

    if (!nav) {

        nav = document.createElement("nav");

        nav.id =
            "scorePathExamTabsV01";

        nav.setAttribute(
            "aria-label",
            "시험 분석 화면"
        );

        nav.style.cssText =
            "display:flex;gap:8px;margin:12px 0;" +
            "position:sticky;top:0;z-index:10;" +
            "padding:6px;background:var(--card-bg,#fff);" +
            "border-radius:12px;";

              // =====================================
        // ScorePath UI 간소화
        // 오늘 / 상세
        // =====================================

        nav.innerHTML = `
            <button
                type="button"
                data-scorepath-tab="recommend"
            >
                🎯 오늘
            </button>

            <button
                type="button"
                data-scorepath-tab="details"
            >
                📊 상세
            </button>
        `;

        summary.insertAdjacentElement(
            "beforebegin",
            nav
        );

        // 버튼 클릭으로 화면 전환
        nav.addEventListener(
            "click",
            (event) => {

                const button =
                    event.target.closest(
                        "[data-scorepath-tab]"
                    );

                if (
                    !button ||
                    !nav.contains(button)
                ) {
                    return;
                }

                scorePathExamTabV01 =
                    button.dataset.scorepathTab;

                applyScorePathExamTabV01();
            }
        );
    }

    // =====================================
    // 선택한 화면만 표시
    // =====================================

    function applyScorePathExamTabV01() {

        for (
            const item of
            [...summary.children]
        ) {

            const title =
                item.querySelector(
                    ".problem-item-title"
                )?.textContent?.trim() || "";

            // 학습 전광판
            const isBoard =
                item.dataset.scorepathBoard ===
                    "main" ||

                title.includes(
                    "ScorePath 학습 전광판"
                );

            // 오늘의 학습 계획
            const isPlan =
                title.includes(
                    "오늘의 학습 계획"
                );

            // 시험 이름, D-day 등은 공통 표시
            const isHeader =
                item.tagName === "STRONG" ||

                item.classList.contains(
                    "check-text"
                );

                // =====================================
            // ScorePath UI 간소화
            // 추천 전광판 + 학습 계획 통합
            // =====================================

            const show =
                isHeader ||

                (
                    scorePathExamTabV01 === "recommend" &&
                    (isBoard || isPlan)
                ) ||

                (
                    scorePathExamTabV01 === "details" &&
                    !isBoard &&
                    !isPlan
                );

            item.hidden = !show;

            item.style.display =
                show ? "" : "none";
        }

        // 단원별 상세 분석 화면
        details.hidden =
            scorePathExamTabV01 !== "details";

        details.style.display =
            scorePathExamTabV01 === "details"
                ? ""
                : "none";

        // =====================================
        // 현재 선택된 탭 강조
        // =====================================

        nav.querySelectorAll(
            "[data-scorepath-tab]"
        ).forEach((button) => {

            const active =
                button.dataset.scorepathTab ===
                scorePathExamTabV01;

            button.setAttribute(
                "aria-current",
                active ? "page" : "false"
            );

            button.style.cssText =
                "flex:1;min-width:0;" +
                "padding:10px 6px;" +
                "border-radius:9px;" +
                "font-weight:600;" +
                "cursor:pointer;" +

                (
                    active
                        ? "background:#2563eb;" +
                          "color:white;" +
                          "border:1px solid #2563eb;"

                        : "background:transparent;" +
                          "color:inherit;" +
                          "border:1px solid #bbb;"
                );
        });
    }

    // =====================================
    // 비동기 학습 기록 표시 대응
    // =====================================

    if (
        !summary.dataset.scorepathTabObserver
    ) {

        new MutationObserver(
            applyScorePathExamTabV01
        ).observe(
            summary,
            {
                childList: true
            }
        );

        summary.dataset.scorepathTabObserver =
            "1";
    }

    // =====================================
    // ScorePath 21-116
    // 모바일 좌우 스와이프 화면 전환
    // =====================================

    if (
        !view.dataset.scorepathSwipeBound
    ) {

        let startX = null;
        let startY = null;

          const tabs = [
            "recommend",
            "details"
        ];

        // =====================================
        // 터치 시작
        // =====================================

        view.addEventListener(
            "touchstart",
            (event) => {

                // 입력창이나 버튼을 누를 때는
                // 화면 전환을 시작하지 않는다.

                if (
                    event.touches.length !== 1 ||

                    event.target.closest(
                        "input,textarea,select,button,[contenteditable]"
                    )
                ) {
                    startX = null;
                    return;
                }

                startX =
                    event.touches[0].clientX;

                startY =
                    event.touches[0].clientY;
            },
            {
                passive: true
            }
        );

        // =====================================
        // 터치 종료
        // =====================================

        view.addEventListener(
            "touchend",
            (event) => {

                if (
                    startX === null ||
                    event.changedTouches.length !== 1
                ) {
                    return;
                }

                const dx =
                    event.changedTouches[0].clientX -
                    startX;

                const dy =
                    event.changedTouches[0].clientY -
                    startY;

                startX = null;

                // 수직 스크롤과 짧은 터치를
                // 스와이프로 잘못 판단하지 않는다.
                if (
                    Math.abs(dx) < 85 ||
                    Math.abs(dx) <
                        Math.abs(dy) * 1.8
                ) {
                    return;
                }

                const index =
                    tabs.indexOf(
                        scorePathExamTabV01
                    );

                const nextIndex =
                    Math.max(
                        0,
                        Math.min(
                            tabs.length - 1,
                            index +
                            (dx < 0 ? 1 : -1)
                        )
                    );

                scorePathExamTabV01 =
                    tabs[nextIndex];

                applyScorePathExamTabV01();
            },
            {
                passive: true
            }
        );

        // 이벤트 중복 등록 방지
        view.dataset.scorepathSwipeBound =
            "1";
    }

    applyScorePathExamTabV01();
}


// =====================================
// 기존 시험 분석 함수
// =====================================

function renderExamRisk(
    exam,
    riskProfile,
    rangeStatus,
    unitStats = []
) {
    $("examListView").hidden = true;
    $("examRiskView").hidden = false;
    $("examStudyView").hidden = true;
    $("examResultView").hidden = true;


    // =====================================
    // 기존 시험 위험도
    // =====================================

    const weaknesses =
        Array.isArray(
            riskProfile?.weaknesses
        )
            ? riskProfile.weaknesses
            : [];

    const highCount =
        weaknesses.filter(
            (item) =>
                item.riskLevel === "red"
        ).length;

    const mediumCount =
        weaknesses.filter(
            (item) =>
                item.riskLevel === "yellow"
        ).length;

    const lowCount =
        weaknesses.filter(
            (item) =>
                item.riskLevel === "green"
        ).length;


    // =====================================
    // ScorePath 시험범위 측정 현황
    // =====================================

    const ranges =
        Array.isArray(
            rangeStatus?.ranges
        )
            ? rangeStatus.ranges
            : [];

// =====================================
// ScorePath 19-6
// 시험범위별 실제 풀이 통계
// =====================================

const scorePathUnitStats =
    Array.isArray(unitStats)
        ? unitStats
        : [];

    const totalRangeCount =
        Number(
            rangeStatus?.totalRangeCount ||
            ranges.length ||
            0
        );

    const measuredCount =
        Number(
            rangeStatus?.measuredCount || 0
        );

    const insufficientCount =
        Number(
            rangeStatus?.insufficientCount || 0
        );

    const unmeasuredCount =
        Number(
            rangeStatus?.unmeasuredCount || 0
        );

    const diagnosisRequiredCount =
        Number(
            rangeStatus?.diagnosisRequiredCount ||
            0
        );


    // =====================================
    // D-Day
    // =====================================

    const daysLeft =
        Number.isFinite(
            Number(exam.daysLeft)
        )
            ? Number(exam.daysLeft)
            : null;

    let dDayText =
        "날짜 정보 없음";

    if (daysLeft !== null) {
        if (daysLeft === 0) {
            dDayText = "D-DAY";

        } else if (daysLeft > 0) {
            dDayText =
                `D-${daysLeft}`;

        } else {
            dDayText =
                `D+${Math.abs(daysLeft)}`;
        }
    }


    // =====================================
    // 상단 요약
    // =====================================

    $("examRiskSummary").innerHTML = `
        <strong>
            ${escapeHtml(
                exam.name ||
                "이름 없는 시험"
            )}
        </strong>

        <div class="check-text">
            ${escapeHtml(
                exam.subject ||
                "과목 미지정"
            )}
            ·
            ${escapeHtml(dDayText)}
        </div>

        <div class="check-text">
            목표
            ${Number(
                exam.targetScore || 0
            )}점
            · 하루
                        ${Number(
                exam.dailyStudyMinutes || 0
            )}분
        </div>

        <!-- =====================================
             ScorePath 21-324
             목표 점수와 학습 방향 표시
             ===================================== -->

        ${
            exam.learningBoard
                ?.readiness
                ?.goalSummary

                ? `
                    <div
                        class="check-text"
                        style="margin-top:5px;"
                    >
                        ${escapeHtml(
                            exam.learningBoard
                                .readiness
                                .goalSummary
                        )}
                    </div>
                `

                : ""
        }

        <div class="problem-item" style="margin-top:12px;">

            <div class="problem-item-title">
                📊 ScorePath 학습 전광판 (V0.1)
            </div>

            <div class="check-text">
                시험 점수 예측:
                ${escapeHtml(
                    exam.learningBoard?.predictionMessage ||
                    "예측 준비 중"
                )}
            </div>

            <div class="check-text">
                풀이 근거 확보:
                ${Number(exam.learningBoard?.evidenceUnits || 0)}/
                ${Number(exam.learningBoard?.totalUnits || 0)}단원

                · 고유 문제
                ${Number(
                    exam.learningBoard?.totalUniqueProblems || 0
                )}개
            </div>

                       <!-- =====================================
                 ScorePath 21-77
                 남은 시간 + 추천 판단 근거
                 ===================================== -->

                        <!-- =====================================
                 ScorePath 21-98
                 시험 대비 학습 상태
                 ===================================== -->

            <div
                class="check-text"
                style="margin-top:10px;"
            >
                🧭 학습 근거:

                숙련도 산출
                ${
                    Number(
                        exam.learningBoard
                            ?.readiness
                            ?.measuredUnits ?? 0
                    )
                }/${
                    Number(
                        exam.learningBoard
                            ?.totalUnits ?? 0
                    )
                }단원

                · 근거 보통 이상
                ${
                    Number(
                        exam.learningBoard
                            ?.evidenceUnits ?? 0
                    )
                }단원
            </div>

            <div
                class="check-text"
                style="margin-top:5px;"
            >
                ${escapeHtml(
                    exam.learningBoard
                        ?.readiness
                        ?.message ||
                    "학습 데이터 확인 중"
                )}
            </div>

            <!-- ScorePath 21-318:
                 목표 점수와 단원 숙련도 비교 UI 제거.
                 목표 점수는 상단 시험 정보에서 확인한다. -->

                        <!-- =====================================
                 ScorePath 21-101
                 학습 완료 후 변화 표시
                 ===================================== -->

            ${
                exam.learningBoard?.lastCompletedStudy
                    ? `
                        <div
                            class="check-text"
                            style="margin-top:10px;"
                        >
                            📈 최근 완료한 학습:

                            ${escapeHtml(
                                exam.learningBoard
                                    .lastCompletedStudy.unit
                            )}

                            · 신규 고유 문제

                            ${
                                Number(
                                    exam.learningBoard
                                        .lastCompletedStudy
                                        .newUniqueAttempts
                                ) || 0
                            }개

                            · 이번 학습 정답률

                            ${
                                exam.learningBoard
                                    .lastCompletedStudy
                                    .accuracy == null

                                    ? "측정 불가"

                                    : Number(
                                        exam.learningBoard
                                            .lastCompletedStudy
                                            .accuracy
                                    ) + "%"
                            }
                        </div>

                        <div
                            class="check-text"
                            style="margin-top:5px;"
                        >
                            📊 추정 숙련도 변화:

                            ${
                                exam.learningBoard
                                    .lastCompletedStudy
                                    .masteryChangePp == null

                                    ? "비교 근거 부족"

                                    : (
                                        Number(
                                            exam.learningBoard
                                                .lastCompletedStudy
                                                .masteryChangePp
                                        ) > 0
                                            ? "+"
                                            : ""
                                    ) +

                                    Number(
                                        exam.learningBoard
                                            .lastCompletedStudy
                                            .masteryChangePp
                                    ).toFixed(1) + "%p"
                            }
                        </div>

                        <div
                            class="check-text"
                            style="margin-top:5px;"
                        >
                            🎯 추천 1순위 비교:

                            ${
                                exam.learningBoard
                                    .lastCompletedStudy
                                    .recommendationComparison

                                    ? escapeHtml(
                                        exam.learningBoard
                                            .lastCompletedStudy
                                            .recommendationComparison
                                            .before
                                    ) +

                                    " → " +

                                    escapeHtml(
                                        exam.learningBoard
                                            .lastCompletedStudy
                                            .recommendationComparison
                                            .after
                                    ) +

                                    (
                                        exam.learningBoard
                                            .lastCompletedStudy
                                            .recommendationComparison
                                            .changed

                                            ? " (변경)"
                                            : " (유지)"
                                    )

                                    : "비교 기록 없음 (새 학습부터 기록)"
                            }
                        </div>

                        <div
                            class="check-text"
                            style="margin-top:4px;"
                        >
                            ※ 추천 변화는 풀이 기록뿐 아니라
                            시간·시험 설정의 영향도 받습니다.
                        </div>
                    `
                    : ""
            }

            <div
                class="check-text"
                style="margin-top:10px;"
            >
                ⏳ 시험 전 계획상 공부시간:

                ${
                    exam.learningBoard?.remainingDays == null
                        ? "시험일 확인 필요"
                        : exam.learningBoard.remainingDays < 0
                            ? "시험 종료"
                            : `
                                약 ${
                                    Math.floor(
                                        Number(
                                            exam.learningBoard
                                                .remainingPlannedMinutes
                                        ) / 60
                                    )
                                }시간 ${
                                    Number(
                                        exam.learningBoard
                                            .remainingPlannedMinutes
                                    ) % 60
                                }분
                            `
                }
            </div>

            <div
                class="check-text"
                style="margin-top:10px;"
            >
                <strong>
                    🎯 다음 추천 공부:
                    ${escapeHtml(
                        exam.learningBoard?.nextStudy?.unit ||
                        "추천 준비 중"
                    )}
                </strong>

                ${
                    exam.learningBoard?.nextStudy
                        ? `· ${Number(
                            exam.learningBoard.nextStudy.minutes
                        )}분`
                        : ""
                }
            </div>

                        <div
                class="check-text"
                style="margin-top:6px;"
            >
                ${escapeHtml(
                    exam.learningBoard?.nextStudy?.activityTitle ||
                    ""
                )}
            </div>

            <!-- =====================================
                 ScorePath 21-104
                 구체적인 공부 행동 안내
                 ===================================== -->

            ${
                exam.learningBoard?.nextStudy
                    ? `
                        <div
                            class="check-text"
                            style="margin-top:8px;"
                        >
                            <strong>
                                📝 바로 할 일
                            </strong>

                            <div style="margin-top:4px;">
                                ${escapeHtml(
                                    exam.learningBoard
                                        .nextStudy.activityGuide ||
                                    ""
                                )}
                            </div>
                        </div>

                        <div
                            class="check-text"
                            style="margin-top:8px;"
                        >
                            <strong>
                                🔎 추천 판단의 한계
                            </strong>

                            <div style="margin-top:4px;">
                                ${escapeHtml(
                                    exam.learningBoard
                                        .nextStudy.evidenceNotice ||
                                    ""
                                )}
                            </div>
                        </div>
                    `
                    : ""
            }

            ${
                exam.learningBoard?.nextStudy
                    ? `
                        <div
                            class="check-text"
                            style="margin-top:8px;"
                        >
                            <strong>
                                💡 왜 이 공부를 추천하나요?
                            </strong>

                            <div style="margin-top:4px;">
                                ${escapeHtml(
                                    exam.learningBoard.nextStudy.reason ||
                                    "현재 학습 기록을 바탕으로 정한 우선순위입니다."
                                )}
                            </div>

                            <small>
                                시험 중요도·현재 풀이 기록·남은 시간을
                                참고한 임시 추천이며 성적 상승 예측은 아닙니다.
                            </small>
                        </div>

                        <div
                            class="check-text"
                            style="margin-top:5px;"
                        >
                            📊 판단 근거:
                            고유 문제 ${
                                Number(
                                    exam.learningBoard
                                        .nextStudy.uniqueAttempts
                                ) || 0
                            }개

                            · 근거 수준:
                            ${escapeHtml(
                                exam.learningBoard
                                    .nextStudy.evidenceLevel ||
                                "제한적"
                            )}
                        </div>
                    `
                    : ""
            }

            <div
                class="check-text"
                style="margin-top:6px;"
            >
                ※ 실제 시험 점수의 예측값이나
                예측 확률은 아닙니다.
            </div>

        </div>

               <!-- =====================================
             ScorePath 21-105
             중복 측정 정보 접기
             ===================================== -->

        <details
            class="problem-item"
            style="margin-top:12px;"
        >
            <summary
                class="problem-item-title"
                style="cursor:pointer;"
            >
                시험범위 상세 측정 현황
                · ${measuredCount}/${totalRangeCount}단원
            </summary>

            <div
                class="check-text"
                style="margin-top:8px;"
            >
                측정됨
                ${measuredCount}/${totalRangeCount}

                · 데이터 부족
                ${insufficientCount}

                · 미측정
                ${unmeasuredCount}
            </div>

            <div class="check-text">
                추가 학습 근거 필요
                ${diagnosisRequiredCount}개
            </div>

            <div
                class="check-text"
                style="margin-top:6px;"
            >
                문제 풀이 기록이 쌓이면
                학습 상태와 추천이 갱신됩니다.
                AI 진단은 선택 사항입니다.
            </div>
        </details>

        <div
            class="check-text"
            style="margin-top:12px;"
        >
            기존 약점 분석 ·
            🔴 고위험 ${highCount}개
            · 🟡 중위험 ${mediumCount}개
            · 🟢 저위험 ${lowCount}개
        </div>
    `;

// =====================================
// ScorePath 21-106
// 전광판에서 지금 해야 할 공부를
// 가장 위에 표시
// =====================================

const scorePathBoardCard =
    [...$("examRiskSummary").children]
        .find((element) =>

            element.classList.contains(
                "problem-item"
            ) &&

            element.querySelector(
                ".problem-item-title"
            )?.textContent.includes(
                "ScorePath 학습 전광판"
            )
        );

if (scorePathBoardCard) {

    scorePathBoardCard.dataset.scorepathBoard =
        "main";

    // =====================================
    // 간결한 제목
    // =====================================

    const boardTitle =
        scorePathBoardCard.querySelector(
            ".problem-item-title"
        );

    if (boardTitle) {
        boardTitle.textContent =
            "🎯 오늘의 공부";
    }

    const rows =
        [...scorePathBoardCard.children]
            .filter((element) =>
                element.classList.contains(
                    "check-text"
                )
            );

    const findRow = (label) =>
        rows.find((element) =>
            element.textContent.includes(label)
        );

    // =====================================
    // 핵심 정보만 기본 표시
    // =====================================

    const nextStudyRow =
        findRow("🎯 다음 추천 공부");

    const activityRow =
        nextStudyRow?.nextElementSibling;

    const importantRows = [
        nextStudyRow,
        activityRow
    ].filter((element, index, all) =>
        element &&
        element.parentElement === scorePathBoardCard &&
        all.indexOf(element) === index
    );

    // =====================================
    // 나머지 설명은 상세 보기로 이동
    // =====================================

    if (nextStudyRow) {

        const keepVisible =
            new Set(importantRows);

        const extraRows = rows.filter(
            (row) => !keepVisible.has(row)
        );

        if (extraRows.length) {

            const more =
                document.createElement("details");

            more.className =
                "scorepath-board-more";

            const heading =
                document.createElement("summary");

            heading.textContent =
                "📊 상세 분석과 근거 보기";

            more.appendChild(heading);

            // 기존 분석 정보는 삭제하지 않는다.
            more.append(...extraRows);

            scorePathBoardCard.appendChild(more);
        }
    }

    // 기존 요소를 복사하지 않고
    // 화면 안에서 위치만 이동한다.
    let previous =
        scorePathBoardCard.querySelector(
            ".problem-item-title"
        );

    if (previous) {

        for (const row of importantRows) {

            previous.insertAdjacentElement(
                "afterend",
                row
            );

            previous = row;
        }
    }
}

// =====================================
// ScorePath 21-20
// 시험 단원별 중요도 수정 UI
// =====================================

const importanceUnits =
    Array.isArray(exam.examRange)
        ? exam.examRange
        : [];

if (importanceUnits.length > 0) {

    const importanceBox =
        document.createElement("div");

    importanceBox.className = "problem-item";
    importanceBox.style.marginTop = "12px";

    const importanceRows = importanceUnits.map(
        (unit, index) => {

            const currentImportance =
                Number(exam.unitImportance?.[unit] ?? 3);

            const options = [1, 2, 3, 4, 5]
                .map((value) => `
                    <option
                        value="${value}"
                        ${value === currentImportance ? "selected" : ""}
                    >
                        ${value}단계
                    </option>
                `)
                .join("");

            return `
                <div
                    class="check-text"
                    style="margin:8px 0;"
                >
                    ${escapeHtml(unit)}

                    <select
                        data-importance-index="${index}"
                    >
                        ${options}
                    </select>
                </div>
            `;
        }
    ).join("");

    importanceBox.innerHTML = `
        <div class="problem-item-title">
            📊 시험 단원별 중요도
        </div>

        <div class="check-text">
            1단계: 매우 낮음
            · 5단계: 매우 중요
        </div>

        ${importanceRows}

        <button
            type="button"
            class="secondary-btn"
            data-save-importance
        >
            중요도 저장
        </button>

        <div
            class="check-text"
            data-importance-message
            style="margin-top:8px;"
        ></div>
    `;

    $("examRiskSummary").appendChild(
        importanceBox
    );

    // =====================================
    // 중요도 저장 버튼
    // =====================================

    const saveImportanceBtn =
        importanceBox.querySelector(
            "[data-save-importance]"
        );

    saveImportanceBtn.addEventListener(
        "click",
        async () => {

            const unitImportance = {};

            importanceBox
                .querySelectorAll(
                    "[data-importance-index]"
                )
                .forEach((select) => {

                    const index =
                        Number(select.dataset.importanceIndex);

                    const unit =
                        importanceUnits[index];

                    if (!unit) return;

                    unitImportance[unit] =
                        Number(select.value);
                });

            const messageBox =
                importanceBox.querySelector(
                    "[data-importance-message]"
                );

            saveImportanceBtn.disabled = true;

            messageBox.textContent =
                "중요도를 저장하는 중...";

            try {

                await api(
                    `/api/exams/${encodeURIComponent(exam.id)}/importance`,
                    "PATCH",
                    {
                        unitImportance
                    }
                );

                // 최신 시험 정보 다시 불러오기
                await openExamRisk(exam.id);

            } catch (error) {

                messageBox.textContent =
                    error.message ||
                    "중요도를 저장하지 못했습니다.";

            } finally {

                saveImportanceBtn.disabled = false;
            }
        }
    );
}


// =====================================
// ScorePath 21-13
// 오늘의 학습 계획 + 공부 시작
// =====================================

// =====================================
// ScorePath 21-29
// 시험 분석 시 학습 기록 자동 표시
// =====================================

const dailyPlan =
    exam.dailyStudyPlan || {};

const studySessions =
    Array.isArray(dailyPlan.sessions)
        ? dailyPlan.sessions
        : [];

// 누적 학습 기록 자동 불러오기
loadScorePathStudyHistory(exam.id);

if (studySessions.length > 0) {

    // =====================================
    // ScorePath UI 간소화
    // 오늘의 학습 계획
    // =====================================

    const planHtml = studySessions.map(
        (session, index) => `

            <div
                class="check-text"
                style="
                    padding:12px 0;
                    border-bottom:1px solid #e3eaf5;
                "
            >

                <div
                    style="
                        font-weight:700;
                        margin-bottom:10px;
                    "
                >
                    ${index + 1}순위
                    · ${escapeHtml(session.unit)}
                    · ${Number(session.minutes) || 0}분
                </div>

                <button
                    type="button"
                    class="secondary-btn"
                    data-study-start="${index}"
                >
                    공부 시작
                </button>

            </div>

        `
    ).join("");

        // =====================================
    // ScorePath UI 간소화
    // 학습 계획 기본 접기
    // =====================================

    $("examRiskSummary").insertAdjacentHTML(
        "beforeend",
        `
        <div
            class="problem-item"
            style="margin-top:12px;"
        >

            <details>

                <summary
                    class="problem-item-title"
                    style="cursor:pointer;"
                >
                    📚 오늘의 학습 계획
                    · ${Number(dailyPlan.totalMinutes) || 0}분
                </summary>

                <p class="check-text" style="margin:8px 0;">
                    사용 가능 ${Number(
                        dailyPlan.availableMinutes ??
                        dailyPlan.totalMinutes
                    ) || 0}분

                    · 배정 ${Number(
                        dailyPlan.totalMinutes
                    ) || 0}분

                    ${
                        Number(dailyPlan.unallocatedMinutes) > 0

                            ? `· 미배정 ${
                                Number(dailyPlan.unallocatedMinutes)
                            }분

                            (초기 계획에 배정하지 않은 시간입니다.
                            학습 후 다시 추천을 계산하세요.)`

                            : ""
                    }
                </p>

                <div style="margin-top:12px;">
                    ${planHtml}
                </div>

            </details>

        </div>
        `
    );

    // =====================================
    // ScorePath 21-107
    // 학습 계획을 전광판 바로 아래 배치
    // =====================================

    const mainBoard =
        $("examRiskSummary").querySelector(
            '[data-scorepath-board="main"]'
        );

    const studyPlanCard =
        [...$("examRiskSummary").children]
            .find((element) =>

                element.classList.contains(
                    "problem-item"
                ) &&

                element.querySelector(
                    ".problem-item-title"
                )?.textContent.includes(
                    "오늘의 학습 계획"
                )
            );

    if (mainBoard && studyPlanCard) {

        mainBoard.insertAdjacentElement(
            "afterend",
            studyPlanCard
        );
    }

    // =====================================
    // ScorePath 21-171
    // 전광판 1순위 공부 바로 시작
    // =====================================

    const firstRecommended =
        dailyPlan.sessions?.[0];

    if (mainBoard && firstRecommended) {

        const startTop =
            document.createElement("button");

        startTop.type = "button";
        startTop.className = "secondary-btn";
        startTop.id = "scorePathStartTopStudyV01";

        startTop.textContent =
            `🚀 ${firstRecommended.unit} 공부 시작`;

        startTop.style.marginTop = "12px";

         // =====================================
        // ScorePath UI 간소화
        // 추천 공부 바로 아래에 버튼 배치
        // =====================================

        const nextStudyRow =
            [...mainBoard.children].find(
                (element) =>
                    element.classList.contains(
                        "check-text"
                    ) &&
                    element.textContent.includes(
                        "🎯 다음 추천 공부"
                    )
            );

        const activityRow =
            nextStudyRow?.nextElementSibling;

        const targetRow =
            activityRow?.classList.contains(
                "check-text"
            )
                ? activityRow
                : nextStudyRow;

        if (targetRow) {

            targetRow.insertAdjacentElement(
                "afterend",
                startTop
            );

        } else {

            mainBoard.appendChild(startTop);
        }

        startTop.addEventListener("click", () => {

            // 기존 학습 시작 버튼 재사용
            const original =
                $("examRiskSummary")?.querySelector(
                    '[data-study-start="0"]'
                );

            if (!original) {

                alert("오늘의 학습 계획을 찾을 수 없습니다.");
                return;
            }

            if (original.disabled) {

                setScorePathMainNavigationV01("study");

                alert(
                    "진행 중인 학습이 있습니다. " +
                    "학습 화면에서 이어서 진행하세요."
                );

                return;
            }

            original.click();
        });
    }

        // =====================================
    // ScorePath 21-26
    // 공부 완료 버튼 연결
    // =====================================

    $("examRiskSummary")
        .querySelectorAll("[data-study-complete]")
        .forEach((button) => {

            button.addEventListener("click", async () => {

                const index =
                    Number(button.dataset.studyComplete);

                const session =
                    studySessions[index];

                if (!session) return;

                if (!confirm(`${session.unit} 공부를 완료할까요?`)) {
                    return;
                }

                button.disabled = true;

                              try {

                    // =====================================
                    // ScorePath 21-146
                    // 실제 진행 중인 학습 확인
                    // =====================================

                    const state = await api(
                        "/api/scorepath/study/active"
                    );

                    const active =
                        state.active === true
                            ? state.session
                            : null;

                    // =====================================
                    // 시험과 단원 일치 확인
                    // =====================================

                    if (
                        !active ||

                        String(active.examId) !==
                            String(exam.id) ||

                        active.unit !== session.unit
                    ) {

                        throw new Error(
                            "선택한 단원에 진행 중인 " +
                            "학습이 없습니다."
                        );
                    }

                    // =====================================
                    // 실제 세션 ID로 완료 요청
                    // =====================================

                    const data = await api(
                        "/api/scorepath/study/complete",
                        "POST",
                        {
                            examId:
                                exam.id,

                            unit:
                                session.unit,

                            sessionId:
                                active.id
                        }
                    );

                    const result =
                        data.session?.results || {};

                    // =====================================
                    // ScorePath 21-113
                    // 학습 후 확인 결과 + 다음 공부 안내
                    // =====================================

                    const verification =
                        result.shortVerification || {};

                    const checkText =
                        verification.status === "checked"
                            ? `새 문제 ${verification.newProblems}개 확인 · 정답률 ${verification.accuracy}% (참고용)`
                            : verification.status === "review_needed"
                                ? `새 문제 ${verification.newProblems}개 확인 · 틀린 개념 복습 권장`
                                : verification.status === "insufficient"
                                    ? `새 문제 ${verification.remainingProblems}개 더 풀면 간이 확인 가능`
                                    : "이번 학습 중 새 문제 풀이 없음 · 학습 확인 필요";

                    const next =
                        data.session?.recommendationAfterComplete;

                    // =====================================
                    // ScorePath 21-227
                    // 공부 전후 추천 변화 확인
                    // =====================================

                    // 학습 시작 당시의 추천
                    const before =
                        data.session
                            ?.recommendationAtStart || null;

                    // 비교할 추천 기록이 있는지 확인
                    const canCompare =
                        Boolean(
                            before?.unit &&
                            next?.unit
                        );

                    // 단원 또는 추천 활동이 달라졌는지 비교
                    const recommendationChanged =
                        canCompare &&
                        (
                            String(before.unit) !==
                                String(next.unit) ||

                            String(
                                before.activityTitle || ""
                            ) !==
                                String(
                                    next.activityTitle || ""
                                )
                        );

                    // 추천 변화 상태
                    const changeLabel =
                        !canCompare

                            ? "변화 비교 기록 없음"

                            : recommendationChanged

                                ? "이전 추천과 달라짐"

                                : "이전 추천 유지";

                    // 학생에게 표시할 다음 추천
                    const nextText = next

                        ? `${next.unit} · ${next.minutes}분 ` +
                          `(${next.activityTitle || "학습 진행"}) ` +
                          `· ${changeLabel}`

                        : "현재 다음 추천 없음 · " +
                          "시험일 및 학습 설정 확인";

                    alert(
                        `✅ 공부 완료!\n` +
                        `단원: ${session.unit}\n` +
                        `경과시간: ${data.session?.actualMinutes ?? 0}분\n` +
                        `풀이: ${result.attempts ?? 0}회\n` +
                        `정답률: ${result.accuracy == null ? "측정 불가" : result.accuracy + "%"}\n\n` +
                        `📝 간이 학습 확인: ${checkText}\n` +
                        `🎯 다음 추천: ${nextText}`
                    );

                    await openExamRisk(exam.id);

                } catch (error) {

                    // =====================================
                    // ScorePath 21-329
                    // 시험 전광판 검증 안내
                    // =====================================

                    if (
                        error.data?.verificationRequired === true
                    ) {

                        const checked = Math.max(
                            0,
                            Number(
                                error.data.newUniqueAttempts
                            ) || 0
                        );

                        const remaining = Math.max(
                            0,
                            Number(
                                error.data.remainingProblems
                            ) || 0
                        );

                        button.textContent =
                            `🧪 검증 결과 확인 (${checked}/3)`;

                        alert(
                            `학습 후 확인 단계입니다.\n` +
                            `새 문제 ${checked}/3개 확인됨.\n` +
                            `새로운 문제 ${remaining}개를 더 풀고 ` +
                            `공부 완료 버튼을 다시 눌러주세요.`
                        );

                    } else {

                        alert(
                            error.message ||
                            "공부 완료 기록을 저장하지 못했습니다."
                        );
                    }

                    button.disabled = false;
                }

            });
        });

    // =====================================
    // 기존 공부 시작 버튼 연결
    // =====================================

    $("examRiskSummary")
        .querySelectorAll("[data-study-start]")
        .forEach((button) => {
                        // =====================================
            // ScorePath 21-24
            // 공부 시작 버튼 + 학습 기록 API 연결
            // =====================================

            button.addEventListener("click", async () => {

                const index =
                    Number(button.dataset.studyStart);

                const session =
                    studySessions[index];

                if (!session) return;

                // =====================================
                // ScorePath 21-198
                // 학습 시작 전 시험 연결 확인
                // =====================================

                const examInput =
                    $("scorePathExam");

                const subjectInput =
                    $("subject");

                const examReady = [
                    ...(examInput?.options || [])
                ].some(
                    (option) =>
                        option.value === String(exam.id)
                );

                const subjectReady = [
                    ...(subjectInput?.options || [])
                ].some(
                    (option) =>
                        option.value === String(exam.subject)
                );

                if (!examReady || !subjectReady) {

                    alert(
                        "시험 또는 과목 선택 정보가 준비되지 않았습니다. " +
                        "시험 목록을 다시 불러온 뒤 시작해 주세요."
                    );

                    return;
                }

                // 중복 클릭 방지
                button.disabled = true;

                try {

                    // =====================================
                    // ScorePath 21-226
                    // 공부 시작 전 입력 화면 검증
                    // =====================================

                    const examInput =
                        $("scorePathExam");

                    const unitInput =
                        $("scorePathUnit");

                    const subjectInput =
                        $("subject");

                    const problemInput =
                        $("problem");

                    // 1. 필요한 입력 요소 확인
                    if (
                        !examInput ||
                        !unitInput ||
                        !subjectInput ||
                        !problemInput
                    ) {

                        throw new Error(
                            "문제 입력 화면이 준비되지 않았습니다. " +
                            "새로고침 후 다시 시도해 주세요."
                        );
                    }

                    // 2. 등록된 시험인지 확인
                    const validExam =
                        [...examInput.options].some(
                            (option) =>
                                String(option.value) ===
                                String(exam.id)
                        );

                    // 3. 등록된 과목인지 확인
                    const validSubject =
                        [...subjectInput.options].some(
                            (option) =>
                                option.value ===
                                exam.subject
                        );

                    // 4. 실제 시험범위의 단원인지 확인
                    const validUnit =
                        Array.isArray(
                            exam.examRange
                        ) &&
                        exam.examRange.includes(
                            session.unit
                        );

                    if (
                        !validExam ||
                        !validSubject ||
                        !validUnit
                    ) {

                        throw new Error(
                            "추천 시험·과목·단원 정보가 " +
                            "맞지 않습니다. " +
                            "시험 목록을 다시 불러와 주세요."
                        );
                    }

                    // =====================================
                    // 검증 통과 후에만 서버에 학습 시작 저장
                    // =====================================

                    await api(
                        "/api/scorepath/study/start",
                        "POST",
                        {
                            examId: exam.id,
                            unit: session.unit
                        }
                    );

                } catch (error) {

                    // =====================================
                    // ScorePath 21-291
                    // 일반 공부 진행 중 시험 공부 시작 안내
                    // =====================================

                    if (
                        error.status === 409 &&
                        error.data?.code === "GENERAL_STUDY_ACTIVE"
                    ) {

                        const active =
                            error.data.activeStudy;

                        alert(
                            `진행 중인 일반 공부: ${active?.subject || ""} · ${active?.unit || ""}\n` +
                            "이 공부를 완료하거나 취소한 뒤 시험 공부를 시작해주세요."
                        );

                        // 진행 중인 일반 공부를 확인할 수 있도록
                        // 홈 화면으로 이동
                        setScorePathMainNavigationV01("home");

                    } else {

                        alert(
                            error.message ||
                            "학습 시작 기록을 저장하지 못했습니다."
                        );
                    }

                    button.disabled = false;
                    return;
                }

                                // =====================================
                // ScorePath 21-47
                // 학습 시작 후 버튼 상태 갱신
                // =====================================

                await refreshScorePathActiveStudy(
                    exam.id,
                    studySessions
                );

                // =====================================
                // 2. 기존 문제 입력 기능 실행
                // =====================================

                const examSelect =
                    $("scorePathExam");

                const unitSelect =
                    $("scorePathUnit");

                const subjectSelect =
                    $("subject");

                const problemInput =
                    $("problem");

                if (
                    !examSelect ||
                    !unitSelect ||
                    !subjectSelect ||
                    !problemInput
                ) {
                    return;
                }

                // 시험 자동 선택
                examSelect.value = exam.id;

                examSelect.dispatchEvent(
                    new Event("change")
                );

                // 단원 자동 선택
                unitSelect.value = session.unit;

                // 과목 자동 선택
                subjectSelect.value = exam.subject;

                // =====================================
                // ScorePath 21-134
                // 공부 시작 후 학습 화면 자동 전환
                // =====================================

                // 기존에 입력한 문제와 답은 지우지 않는다.

                // =====================================
                // ScorePath 21-136
                // 학습 화면에서 공부 완료
                // =====================================

                // 1. 학습 화면 표시
                setScorePathMainNavigationV01(
                    "study"
                );

                const inputCard =
                    $("cardInput");

                if (inputCard) {

                    let completeButton =
                        $("scorePathStudyCompleteV01");

                    // =====================================
                    // 완료 버튼 최초 생성
                    // =====================================

                    if (!completeButton) {

                        completeButton =
                            document.createElement("button");

                        completeButton.id =
                            "scorePathStudyCompleteV01";

                        completeButton.type =
                            "button";

                        completeButton.className =
                            "secondary-btn";

                        completeButton.style.margin =
                            "0 0 14px";

                        inputCard
                            .querySelector("h2")
                            ?.insertAdjacentElement(
                                "afterend",
                                completeButton
                            );
                    }

                    completeButton.disabled =
                        false;

                    completeButton.textContent =
                        `✅ ${session.unit} 공부 완료`;

                    // =====================================
                    // 공부 완료 이벤트
                    // =====================================

                    completeButton.onclick =
                        async () => {

                            // 현재 선택한 시험과
                            // 학습을 시작한 시험이 같은지 확인
                            if (
                                String(
                                    $("scorePathExam")?.value || ""
                                ) !== String(exam.id) ||

                                $("scorePathUnit")?.value !==
                                    session.unit
                            ) {

                                alert(
                                    "현재 선택한 시험·단원이 " +
                                    "시작한 학습과 다릅니다.\n" +
                                    "학습 범위를 확인하세요."
                                );

                                return;
                            }

                            if (
                                !confirm(
                                    `${session.unit} 공부를 완료할까요?`
                                )
                            ) {
                                return;
                            }

                            completeButton.disabled =
                                true;

                            try {

                                // =====================================
                                // ScorePath 21-147
                                // 실제 학습 세션 ID 검증
                                // =====================================

                                const activeData =
                                    await api(
                                        "/api/scorepath/study/active"
                                    );

                                const active =
                                    activeData.active === true
                                        ? activeData.session
                                        : null;

                                // 실제 진행 중인 학습과
                                // 완료하려는 학습이 같은지 확인
                                if (
                                    !active ||
                                    !active.id ||

                                    String(active.examId) !==
                                        String(exam.id) ||

                                    String(active.unit) !==
                                        String(session.unit)
                                ) {

                                    throw new Error(
                                        "진행 중인 학습이 변경되었습니다. " +
                                        "전광판에서 학습 상태를 확인하세요."
                                    );
                                }

                                // =====================================
                                // 확인한 세션 ID로 완료 요청
                                // =====================================

                                const data =
                                    await api(
                                        "/api/scorepath/study/complete",
                                        "POST",
                                        {
                                            examId:
                                                exam.id,

                                            unit:
                                                session.unit,

                                            sessionId:
                                                active.id
                                        }
                                    );

                                // =====================================
                                // ScorePath 21-259
                                // 서버의 공부 완료 처리 성공 확인
                                // =====================================

                                completeButton.dataset.scorepathSaved =
                                    "true";

                                const results =
                                    data.session?.results || {};

                                const next =
                                    data.session
                                        ?.recommendationAfterComplete;

                                // 완료된 버튼 제거
                                completeButton.remove();

                                 // =====================================
                                // ScorePath 21-254
                                // 짧은 검증 결과와 다음 추천 이유 표시
                                // =====================================

                                const verification =
                                    results.shortVerification || {};

                                const accuracyText =
                                    verification.accuracy == null
                                        ? "확인 불가"
                                        : `${verification.accuracy}%`;

                                const verificationText =
                                    verification.status === "review_needed"
                                        ? "틀린 개념을 다시 확인하세요."
                                        : verification.status === "checked"
                                            ? "간이 확인 완료(숙련도 확정 아님)"
                                            : "추가 확인 필요";

                                alert(
                                    `✅ 공부 완료!\n` +
                                    `단원: ${session.unit}\n` +
                                    `풀이: ${results.attempts ?? 0}회\n` +
                                    `새 고유 문제: ${results.newUniqueAttempts ?? 0}개\n` +
                                    `첫 풀이 정답률: ${accuracyText}\n` +
                                    `${verificationText}\n\n` +
                                    `🎯 다음 추천: ${
                                        next
                                            ? `${next.unit} · ${next.minutes}분`
                                            : "추천 없음"
                                    }` +
                                    (next?.reason
                                        ? `\n추천 이유: ${next.reason}`
                                        : "")
                                );

                                // =====================================
                                // ScorePath 21-200
                                // 공부 완료 후 추천 갱신 확인
                                // =====================================

                                const reopened =
                                    await openExamRisk(
                                        exam.id
                                    );

                                if (!reopened) {

                                    alert(
                                        "공부 완료 기록은 저장됐지만 " +
                                        "새 추천을 불러오지 못했습니다. " +
                                        "홈에서 시험을 다시 열어 주세요."
                                    );

                                    return;
                                }

                                // 전광판 추천 화면 표시
                                document.querySelector(
                                    '#scorePathExamTabsV01 ' +
                                    '[data-scorepath-tab="recommend"]'
                                )?.click();

                             } catch (error) {

                                // =====================================
                                // ScorePath 21-330
                                // 학습 화면 검증 상태 처리
                                // =====================================

                                if (
                                    completeButton.dataset.scorepathSaved !==
                                        "true" &&

                                    error.data?.verificationRequired ===
                                        true
                                ) {

                                    const checked = Math.max(
                                        0,
                                        Number(
                                            error.data.newUniqueAttempts
                                        ) || 0
                                    );

                                    const remaining = Math.max(
                                        0,
                                        Number(
                                            error.data.remainingProblems
                                        ) || 0
                                    );

                                    completeButton.textContent =
                                        `🧪 검증 결과 확인 (${checked}/3)`;

                                    alert(
                                        `학습 후 확인 단계입니다.\n` +
                                        `새 문제 ${checked}/3개 확인됨.\n` +
                                        `새로운 문제 ${remaining}개를 더 풀고 ` +
                                        `이 버튼을 다시 눌러주세요.`
                                    );

                                    completeButton.disabled = false;

                                } else if (
                                    completeButton.dataset.scorepathSaved ===
                                        "true"
                                ) {

                                    completeButton.remove();

                                    alert(
                                        "학습 결과는 저장됐지만 " +
                                        "추천 화면 갱신에 실패했습니다.\n" +
                                        "홈에서 해당 시험을 다시 열어 " +
                                        "확인해 주세요."
                                    );

                                } else {

                                    alert(
                                        error.message ||
                                        "공부 완료 처리에 실패했습니다."
                                    );

                                    completeButton.disabled = false;
                                }
                            }
                        };
                }

                // 2. 화면이 표시된 다음 문제 입력으로 이동
                requestAnimationFrame(() => {

                    problemInput.scrollIntoView({
                        behavior: "smooth",
                        block: "center"
                    });

                    problemInput.focus({
                        preventScroll: true
                    });

                });

            });

        });
}

// =====================================
// ScorePath 21-46
// 시험 분석 화면 진입 시 학습 상태 복원
// =====================================

refreshScorePathActiveStudy(
    exam.id,
    studySessions
);

// =====================================
// 시험범위 + 기존 약점 출력 영역
// =====================================

    const box =
        $("examRiskWeaknesses");

    box.innerHTML = "";


    // =====================================
    // 시험범위별 측정 상태
    // =====================================

    const rangeTitle =
        document.createElement("div");

    rangeTitle.className =
        "problem-item-title";

    rangeTitle.style.marginTop =
        "12px";

    rangeTitle.style.marginBottom =
        "8px";

    rangeTitle.textContent =
        "시험범위별 현재 상태";

    box.appendChild(rangeTitle);


    if (ranges.length === 0) {

        const emptyRange =
            document.createElement("div");

        emptyRange.className =
            "problem-item";

        emptyRange.innerHTML = `
            <div class="problem-item-text">
                등록된 시험범위를 분석하지 못했습니다.
            </div>
        `;

        box.appendChild(emptyRange);

    } else {

        ranges.forEach(
            (item, index) => {

                const div =
                    document.createElement(
                        "div"
                    );

                div.className =
                    "problem-item";


                let statusIcon = "⚪";
                let statusText = "미측정";

                if (
                    item.measurementStatus ===
                    "measured"
                ) {
                    statusIcon = "🟢";
                    statusText = "측정됨";

                } else if (
                    item.measurementStatus ===
                    "insufficient"
                ) {
                    statusIcon = "🟡";
                    statusText =
                        "데이터 부족";
                }

// =====================================
// ScorePath 19-7
// 현재 시험범위의 풀이 통계
// =====================================

const unitStat =
    scorePathUnitStats.find(
        (stat) =>
            String(stat.unit) ===
            String(item.rangeName)
    );

const attempts =
    Number(unitStat?.attempts || 0);

const correctCount =
    Number(unitStat?.correctCount || 0);

const wrongCount =
    Number(unitStat?.wrongCount || 0);

const accuracy =
    attempts > 0
        ? Math.round(
            (correctCount / attempts) * 100
        )
        : 0;
// =====================================
// ScorePath 20-2
// 초기 학습 우선순위 판단
// =====================================

// =====================================
// ScorePath 21-58
// 숙련도 엔진과 학습 우선순위 화면 연결
// =====================================

// 서버가 계산한 학습 신호 가져오기
const learningSignal =
    Array.isArray(exam.learningSignals)
        ? exam.learningSignals.find(
            (signal) =>
                String(signal.unit) ===
                String(item.rangeName)
        )
        : null;

// 서로 다른 문제 수
const uniqueAttempts =
    Math.max(
        0,
        Number(
            unitStat?.uniqueAttempts ??
            attempts
        ) || 0
    );

// 풀이 데이터의 근거 범위
const evidenceLevel =
    learningSignal?.evidenceLevel ||
    "제한적";

// 서버의 판단 결과로 표시
let studyPriority = "";

if (uniqueAttempts === 0) {

    studyPriority =
        "학습 데이터 없음";

} else if (
    !learningSignal ||
    learningSignal.needsMoreEvidence
) {

    studyPriority =
        "서로 다른 문제 추가 풀이 권장";

} else if (
    learningSignal.nextAction === "review"
) {

    studyPriority =
        "유지 및 복습";

} else if (
    Number(learningSignal.estimatedMastery) < 60
) {

    studyPriority =
        "집중 학습 권장";

} else {

    studyPriority =
        "다른 유형·난이도 추가 연습";
}

// =====================================
// 시험 임박 여부 반영
// =====================================

const isExamSoon =
    daysLeft !== null &&
    daysLeft >= 0 &&
    daysLeft <= 7;

if (isExamSoon) {

    studyPriority =
        `시험 임박 · ${studyPriority}`;
}

                const evidenceCount =
                    Number(
                        item.evidenceCount ||
                        0
                    );


                const weaknessText =
                    Number.isFinite(
                        Number(
                            item.averageWeaknessScore
                        )
                    ) &&
                    item.averageWeaknessScore !==
                        null
                        ? ` · 약점 점수 ${Number(
                            item.averageWeaknessScore
                        )}`
                        : "";


                div.innerHTML = `
                    <div class="problem-item-title">
                        ${index + 1}.
                        ${escapeHtml(
                            item.rangeName ||
                            "범위 미지정"
                        )}
                    </div>

                    <div class="check-text">
                        ${statusIcon}
                        ${escapeHtml(
                            statusText
                        )}
                        · 확보 데이터
                        ${evidenceCount}개
                        ${weaknessText}
                    </div>

<div class="check-text" style="margin-top:8px;">
    풀이 ${attempts}회
    · 고유 문제 ${uniqueAttempts}개
    · 정답 ${correctCount}회
    · 오답 ${wrongCount}회
    · 전체 정답률 ${accuracy}%
</div>

<div class="check-text" style="margin-top:6px;">
    추정 숙련도:
    ${
        learningSignal?.estimatedMastery == null
            ? "데이터 부족"
            : `${Number(learningSignal.estimatedMastery)}% (참고용)`
    }
    · 풀이 근거: ${escapeHtml(evidenceLevel)}
</div>

<div class="check-text" style="margin-top:5px;">
    📌 기록 출처:
    ${escapeHtml(({
        current_measured: "이번 시험 풀이(5문제 이상)",
        current_partial: "이번 시험 풀이(추가 확인 필요)",
        past_history: "과거 풀이 참고",
        past_wrong_note: "과거 오답 참고",
        no_records: "기록 없음"
    })[learningSignal?.evidenceSource] || "기록 확인 중")}

    ${
        Number(learningSignal?.pastEvidence?.historicalUniqueCount || 0) +
        Number(learningSignal?.pastEvidence?.legacyWrongCount || 0) > 0
            ? ` · 과거 풀이 ${Number(learningSignal?.pastEvidence?.historicalUniqueCount || 0)}문제
                 · 별도 오답 ${Number(learningSignal?.pastEvidence?.legacyWrongCount || 0)}개`
            : ""
    }
</div>

<!-- =====================================
     ScorePath 21-80
     난이도별 풀이 기록 표시
     ===================================== -->

<div class="check-text" style="margin-top:6px;">
    기록된 난이도별 고유 문제:

    쉬움 ${
        Number(
            unitStat?.difficultyStats?.["쉬움"]?.attempts
        ) || 0
    }개

    · 보통 ${
        Number(
            unitStat?.difficultyStats?.["보통"]?.attempts
        ) || 0
    }개

    · 어려움 ${
        Number(
            unitStat?.difficultyStats?.["어려움"]?.attempts
        ) || 0
    }개

    · 난이도 미기록 ${
        Number(
            unitStat?.difficultyUnknownCount
        ) || 0
    }개
</div>

${
    uniqueAttempts >= 5 &&
    learningSignal?.hasDifficultyCoverage !== true
        ? `
            <div
                class="check-text"
                style="margin-top:5px;"
            >
                ⚠️ 난이도 정보 또는 다양성이 부족합니다.
                숙련도 수치를 실제 시험 실력으로
                단정하지 마세요.
            </div>
        `
        : ""
}

<div class="check-text" style="margin-top:6px;">
    📊 학습 우선순위:
    ${escapeHtml(studyPriority)}
</div>
${
    item.diagnosisRequired
        ? `
            <div class="check-text" style="margin-top:8px;">
                📌 ${
                    Number(learningSignal?.pastEvidence?.pastWeaknessCount || 0) > 0
                        ? "과거 오답 개념을 복습하고 새 문제 2~3개로 현재 실력을 확인하세요."
                        : Number(learningSignal?.pastEvidence?.historicalUniqueCount || 0) > 0
                            ? "과거에 푼 단원입니다. 새 문제 2~3개로 먼저 재확인하세요."
                            : uniqueAttempts > 0
                                ? "현재 풀이 기록이 있으니, 난이도가 다른 새 문제로 추가 확인하세요."
                                : "현재 기록이 없습니다. 짧은 실력 확인부터 시작하세요."
                }
            </div>

            ${
                (daysLeft === null || daysLeft > 3) &&
                learningSignal?.evidenceSource === "no_records"
                    ? `
                        <div class="check-text" style="margin-top:6px;">
                            AI 3문제 진단은 선택 사항이며, 정확한 실력 확정용이 아닙니다.
                        </div>

                        <button type="button" class="secondary-btn"
                            data-start-exam-diagnosis="${escapeHtml(item.rangeName || "")}">
                            AI로 빠른 진단 (선택 · 비용 발생 가능)
                        </button>
                    `
                    : ""
            }
        `
        : `
            <div class="check-text" style="margin-top:8px;">
                ✅ 현재 풀이 기록을 바탕으로 추천을 계산합니다.
            </div>
        `
}
                `;

                box.appendChild(div);
            }
        );
    }


    // =====================================
    // 기존 약점 분석
    // =====================================

    const weaknessTitle =
        document.createElement("div");

    weaknessTitle.className =
        "problem-item-title";

    weaknessTitle.style.marginTop =
        "18px";

    weaknessTitle.style.marginBottom =
        "8px";

    weaknessTitle.textContent =
        "시험범위 내 기존 약점";

    box.appendChild(weaknessTitle);

    // =====================================
    // ScorePath 21-115
    // 시험 분석 화면에 3탭 연결
    // =====================================

    // 기존 전광판과 학습 계획을
    // 모두 생성한 뒤 탭을 적용한다.

    // 약점 데이터가 없어도
    // 탭은 항상 표시한다.

    setupScorePathExamTabsV01();

    if (weaknesses.length === 0) {

        const emptyWeakness =
            document.createElement("div");

        emptyWeakness.className =
            "problem-item";

        emptyWeakness.innerHTML = `
            <div class="problem-item-text">
                시험범위와 일치하는 기존 약점 데이터가 없습니다.
            </div>
        `;

        box.appendChild(
            emptyWeakness
        );

        return;
    }


    weaknesses.forEach(
        (item, index) => {

            const div =
                document.createElement(
                    "div"
                );

            div.className =
                "problem-item";

            let riskIcon = "🟢";
            let riskText = "저위험";

            if (
                item.riskLevel === "red"
            ) {
                riskIcon = "🔴";
                riskText = "고위험";

            } else if (
                item.riskLevel ===
                "yellow"
            ) {
                riskIcon = "🟡";
                riskText = "중위험";
            }


            div.innerHTML = `
                <div class="problem-item-title">
                    ${index + 1}.
                    ${escapeHtml(
                        item.label ||
                        item.weakConcept ||
                        item.concept ||
                        "분류되지 않은 약점"
                    )}
                </div>

                <div class="check-text">
                    ${riskIcon}
                    ${riskText}
                    · 위험도
                    ${Number(
                        item.riskScore || 0
                    )}
                </div>

                <div class="check-text">
                    반복 오답
                    ${Number(
                        item.wrongCount || 0
                    )}회
                    · 약점 점수
                    ${Number(
                        item.weaknessScore || 0
                    )}
                </div>
            `;

            box.appendChild(div);
        }
    );
}

// =====================================
// ScorePath 시험범위 진단 시작
// =====================================

let currentExamDiagnosisState = null;


async function startExamDiagnosis(
    rangeName
) {
    if (
        !selectedExamState ||
        !selectedExamState.examId
    ) {
        $("examModeMessage").textContent =
            "먼저 시험을 선택해주세요.";

        return;
    }


    const cleanRangeName =
        String(rangeName || "").trim();


    if (!cleanRangeName) {
        $("examModeMessage").textContent =
            "진단할 시험범위를 찾을 수 없습니다.";

        return;
    }


    $("examModeMessage").textContent =
        "진단 문제를 준비하는 중...";


    try {
        const data =
            await api(
                `/api/exams/${
                    selectedExamState.examId
                }/diagnosis/start`,
                "POST",
                {
                    rangeName:
                        cleanRangeName
                }
            );


        if (
            !data.attempt ||
            !data.currentProblem
        ) {
            throw new Error(
                "진단 문제를 불러오지 못했습니다."
            );
        }


        currentExamDiagnosisState = {
            ...data.attempt,

            currentProblem:
                data.currentProblem
        };


        renderExamDiagnosisProblem(
            currentExamDiagnosisState
        );


    } catch (error) {
        console.error(
            "EXAM DIAGNOSIS START ERROR:",
            error
        );


        $("examModeMessage").textContent =
            error.message ||
            "진단을 시작하지 못했습니다.";
    }
}


function renderExamDiagnosisProblem(
    attempt
) {
    if (
        !attempt ||
        !attempt.currentProblem
    ) {
        return;
    }


    $("examListView").hidden = true;
    $("examRiskView").hidden = true;
    $("examStudyView").hidden = false;
    $("examResultView").hidden = true;


    const currentIndex =
        Number(
            attempt.currentIndex || 0
        );


    const problemCount =
        Number(
            attempt.problemCount || 3
        );


    const currentProblem =
        attempt.currentProblem;


    $("examStudyProgress").textContent =
        `진단 ${currentIndex + 1} / ${problemCount}`;


    $("examStudyProblem").innerHTML = `
        <div class="problem-item-title">
            ${escapeHtml(
                attempt.subject ||
                "과목 미지정"
            )}
            ·
            ${escapeHtml(
                attempt.rangeName ||
                "범위 미지정"
            )}
        </div>

        <div class="check-text">
            ${
                currentProblem.role === "basic"
                    ? "기본 개념"
                    : currentProblem.role ===
                      "application"
                    ? "기본 적용"
                    : "시험 적용"
            }
            ·
            ${escapeHtml(
                currentProblem.difficulty ||
                ""
            )}
        </div>

        <div
            class="problem-item-text"
            style="margin-top:12px;"
        >
            ${escapeHtml(
                currentProblem.problem ||
                "문제를 불러오지 못했습니다."
            )}
        </div>
    `;


    $("examStudyAnswer").value = "";

    $("examStudyFeedback").textContent =
        "현재 실력을 측정하는 진단 문제입니다.";


    $("examModeMessage").textContent = "";

    $("examStudyAnswer").focus();
}


// =====================================
// 시험범위 진단 버튼 이벤트 연결
// =====================================

document.addEventListener(
    "click",
    (event) => {
        const button =
            event.target.closest(
                "[data-start-exam-diagnosis]"
            );


        if (!button) {
            return;
        }


        const rangeName =
            button.dataset
                .startExamDiagnosis;


        startExamDiagnosis(
            rangeName
        );
    }
);

function backToExamList() {
    $("examListView").hidden = false;
    $("examRiskView").hidden = true;
    $("examStudyView").hidden = true;
    $("examResultView").hidden = true;

    $("examModeMessage").textContent = "";

    selectedExamState = null;
}


// =====================================
// 7-5-4 시험 대비 풀이 시작
// =====================================

let currentExamAttemptState = null;


function renderExamStudyAttempt(attempt) {
    if (!attempt) {
        return;
    }

    currentExamAttemptState = attempt;

    $("examListView").hidden = true;
    $("examRiskView").hidden = true;
    $("examStudyView").hidden = false;
    $("examResultView").hidden = true;

    const currentIndex =
        Number(attempt.currentIndex || 0);

    const totalCount =
        Number(attempt.totalCount || 0);

    $("examStudyProgress").textContent =
        `${currentIndex + 1} / ${totalCount}`;

    const currentProblem =
        attempt.currentProblem || {};

    $("examStudyProblem").innerHTML = `
        <div class="problem-item-title">
            ${escapeHtml(
                attempt.subject ||
                "과목 미지정"
            )}
        </div>

        <div class="problem-item-text">
            ${escapeHtml(
                currentProblem.problem ||
                "문제를 불러오지 못했습니다."
            )}
        </div>

        ${
            currentProblem.unit
                ? `
                    <div class="check-text">
                        단원:
                        ${escapeHtml(
                            currentProblem.unit
                        )}
                    </div>
                `
                : ""
        }

        ${
            currentProblem.weakConcept
                ? `
                    <div class="check-text">
                        관련 개념:
                        ${escapeHtml(
                            currentProblem.weakConcept
                        )}
                    </div>
                `
                : ""
        }
    `;

    $("examStudyAnswer").value = "";

    $("examStudyFeedback").textContent = "";

    $("examModeMessage").textContent = "";

    $("examStudyAnswer").focus();
}


async function startExamStudy() {
    if (
        !selectedExamState ||
        !selectedExamState.examId
    ) {
        $("examModeMessage").textContent =
            "먼저 시험을 선택해주세요.";

        return;
    }

    const button =
        $("startExamStudyBtn");

    button.disabled = true;

    $("examModeMessage").textContent =
        "시험 대비 문제를 준비하는 중...";

    try {
        const data =
            await api(
                `/api/exams/${encodeURIComponent(
                    selectedExamState.examId
                )}/study-attempt/start`,
                "POST"
            );

        if (!data.attempt) {
            throw new Error(
                "시험 대비 문제를 불러오지 못했습니다."
            );
        }

        renderExamStudyAttempt(
            data.attempt
        );

    } catch (error) {
        console.error(
            "EXAM STUDY START ERROR:",
            error
        );

        $("examModeMessage").textContent =
            error.message ||
            "시험 대비 풀이를 시작하지 못했습니다.";

    } finally {
        button.disabled = false;
    }
}


// =====================================
// 7-5-5 시험 대비 답 제출 + 채점
// =====================================

let pendingExamNextProblem = null;


async function submitExamStudyAnswer() {
    if (
        !currentExamAttemptState ||
        !currentExamAttemptState.id
    ) {
        $("examModeMessage").textContent =
            "진행 중인 시험 대비 풀이가 없습니다.";

        return;
    }

    const answerInput =
        $("examStudyAnswer");

    const userAnswer =
        answerInput.value.trim();

    if (!userAnswer) {
        $("examStudyFeedback").textContent =
            "답을 입력해주세요.";

        answerInput.focus();

        return;
    }

    const button =
        $("submitExamStudyAnswerBtn");

    button.disabled = true;
    answerInput.disabled = true;

    $("examStudyFeedback").textContent =
        "채점하는 중...";

    try {
        const data =
            await api(
                "/api/exams/study-attempt/check",
                "POST",
                {
                    attemptId:
                        currentExamAttemptState.id,

                    userAnswer
                }
            );

        if (data.duplicate) {
            if (
                data.completed &&
                data.result
            ) {
                renderExamResult(
                    data.result
                );

                return;
            }

            $("examStudyFeedback").textContent =
                data.message ||
                "이미 처리된 문제입니다.";

            return;
        }

        const isCorrect =
            data.isCorrect === true;

        const answeredProblem =
            data.answeredProblem || {};

        const correctAnswer =
            answeredProblem.correctAnswer ||
            data.correctAnswer ||
            "";

        if (isCorrect) {
            $("examStudyFeedback").innerHTML = `
                <strong>
                    ⭕ 정답입니다!
                </strong>
            `;
        } else {
            $("examStudyFeedback").innerHTML = `
                <strong>
                    ❌ 오답입니다.
                </strong>

                ${
                    correctAnswer
                        ? `
                            <div>
                                정답:
                                ${escapeHtml(
                                    correctAnswer
                                )}
                            </div>
                        `
                        : ""
                }
            `;
        }

        currentExamAttemptState.correctCount =
            Number(
                data.progress?.correctCount ??
                currentExamAttemptState.correctCount ??
                0
            );

        currentExamAttemptState.wrongCount =
            Number(
                data.progress?.wrongCount ??
                currentExamAttemptState.wrongCount ??
                0
            );

        // =====================================
        // 마지막 문제까지 완료
        // =====================================

        if (data.completed) {
            pendingExamNextProblem = null;

            const result =
                data.result || {
                    totalCount:
                        Number(
                            currentExamAttemptState
                                .totalCount || 0
                        ),

                    correctCount:
                        Number(
                            currentExamAttemptState
                                .correctCount || 0
                        ),

                    wrongCount:
                        Number(
                            currentExamAttemptState
                                .wrongCount || 0
                        ),

                    accuracy: 0
                };

            if (
                result.accuracy == null
            ) {
                const total =
                    Number(
                        result.totalCount || 0
                    );

                const correct =
                    Number(
                        result.correctCount || 0
                    );

                result.accuracy =
                    total > 0
                        ? Math.round(
                            (
                                correct /
                                total
                            ) * 100
                        )
                        : 0;
            }

            renderExamResult(result);

            return;
        }

        // =====================================
        // 다음 문제가 있는 경우
        // =====================================

        pendingExamNextProblem =
            data.nextProblem || null;

        if (!pendingExamNextProblem) {
            throw new Error(
                "다음 문제 정보를 불러오지 못했습니다."
            );
        }

        const nextButton =
            document.createElement(
                "button"
            );

        nextButton.type =
            "button";

        nextButton.className =
            "secondary-btn";

        nextButton.textContent =
            "다음 문제";

        nextButton.addEventListener(
            "click",
            () => {
                moveToNextExamProblem();
            }
        );

        $("examStudyFeedback")
            .appendChild(
                document.createElement(
                    "br"
                )
            );

        $("examStudyFeedback")
            .appendChild(
                nextButton
            );

    } catch (error) {
        console.error(
            "EXAM STUDY CHECK ERROR:",
            error
        );

        $("examStudyFeedback").textContent =
            error.message ||
            "채점하지 못했습니다.";

        answerInput.disabled = false;
        button.disabled = false;
    }
}


function moveToNextExamProblem() {
    if (!pendingExamNextProblem) {
        return;
    }

    const nextProblem =
        pendingExamNextProblem;

    const nextIndex =
        Number(
            nextProblem.number || 1
        ) - 1;

    currentExamAttemptState.currentIndex =
        nextIndex;

    currentExamAttemptState.currentProblem =
        nextProblem;

    pendingExamNextProblem = null;

    renderExamStudyAttempt(
        currentExamAttemptState
    );

    $("examStudyAnswer").disabled =
        false;

    $("submitExamStudyAnswerBtn").disabled =
        false;
}


// =====================================
// 7-5-7 시험 대비 최종 결과
// =====================================

function renderExamResult(result) {
    $("examListView").hidden = true;
    $("examRiskView").hidden = true;
    $("examStudyView").hidden = true;
    $("examResultView").hidden = false;

    const totalCount =
        Number(
            result.totalCount || 0
        );

    const correctCount =
        Number(
            result.correctCount || 0
        );

    const wrongCount =
        Number(
            result.wrongCount || 0
        );

    const accuracy =
        Number.isFinite(
            Number(result.accuracy)
        )
            ? Number(result.accuracy)
            : (
                totalCount > 0
                    ? Math.round(
                        (
                            correctCount /
                            totalCount
                        ) * 100
                    )
                    : 0
            );

    $("examResultTotal").textContent =
        String(totalCount);

    $("examResultCorrect").textContent =
        String(correctCount);

    $("examResultWrong").textContent =
        String(wrongCount);

    $("examResultAccuracy").textContent =
        `${accuracy}%`;

    $("examModeMessage").textContent = "";

    currentExamAttemptState = null;
    pendingExamNextProblem = null;
}


function finishExamStudy() {
    currentExamAttemptState = null;
    pendingExamNextProblem = null;

    loadExamList();
}


// =====================================
// 7단계 - 시험 모드 버튼 이벤트
// =====================================

const startExamStudyButton =
    $("startExamStudyBtn");

const backToExamListButton =
    $("backToExamListBtn");

const submitExamStudyAnswerButton =
    $("submitExamStudyAnswerBtn");

const finishExamStudyButton =
    $("finishExamStudyBtn");


if (startExamStudyButton) {
    startExamStudyButton.addEventListener(
        "click",
        startExamStudy
    );
}


if (backToExamListButton) {
    backToExamListButton.addEventListener(
        "click",
        backToExamList
    );
}


if (submitExamStudyAnswerButton) {
    submitExamStudyAnswerButton.addEventListener(
        "click",
        submitExamStudyAnswer
    );
}


if (finishExamStudyButton) {
    finishExamStudyButton.addEventListener(
        "click",
        finishExamStudy
    );
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

    let res;

    try {
        res = await fetch(url, options);
    } catch (error) {
        throw new Error(
            "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요."
        );
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
        const error = new Error(
            data.error || "요청 중 오류가 발생했습니다."
        );

        error.status = res.status;
        error.verification = data.verification || "";
        error.data = data;

        throw error;
    }

    return data;
}

// =====================================
// 문제 사진 입력
// OCR 호출 없음
// 사진 → 범위 선택 → Crop → 압축
// =====================================

function readImageFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
            resolve(reader.result);
        };

        reader.onerror = () => {
            reject(
                new Error(
                    "사진 파일을 읽지 못했습니다."
                )
            );
        };

        reader.readAsDataURL(file);
    });
}


async function openProblemImageCrop(file) {
    if (!file) {
        return;
    }

    if (scorePathPhotoPartsV01.length >= 3) {
        showMessage("문제 하나에 사진은 최대 3장까지 첨부할 수 있습니다.", "red");
        return;
    }

    if (!/^(image\/(?:jpeg|png|webp))$/.test(file.type) || file.size > 12 * 1024 * 1024) {
        showMessage(
            "JPG·PNG·WebP 사진(원본 12MB 이하)만 선택할 수 있습니다.",
            "red"
        );

        return;
    }

    try {
        $("selectProblemImageBtn").disabled = true;

        $("imageLoadingText").textContent =
            "사진을 준비하는 중입니다...";

        const sourceDataUrl =
            await readImageFileAsDataUrl(file);

        imageCropState = {
            sourceDataUrl,
            startX: 0,
            startY: 0,
            endX: 0,
            endY: 0,
            dragging: false
        };

        const image =
            $("imageCropSource");

        image.onload = () => {
            $("imageCropSelection").style.display =
                "none";

            $("imageCropModal").hidden = false;

            $("imageLoadingText").textContent = "";
        };

        image.onerror = () => {
            showMessage(
                "사진을 불러오지 못했습니다.",
                "red"
            );

            $("imageLoadingText").textContent = "";
        };

        image.src = sourceDataUrl;

    } catch (error) {
        showMessage(
            error.message ||
                "사진을 읽지 못했습니다.",
            "red"
        );

    } finally {
        $("selectProblemImageBtn").disabled = false;

        // 같은 사진도 다시 선택 가능
        $("problemImageInput").value = "";
    }
}


// =====================================
// Crop 좌표 계산
// =====================================

function getCropPointerPosition(event) {
    const stage =
        $("imageCropStage");

    const rect =
        stage.getBoundingClientRect();

    let clientX;
    let clientY;

    if (event.touches?.length) {
        clientX =
            event.touches[0].clientX;

        clientY =
            event.touches[0].clientY;

    } else if (
        event.changedTouches?.length
    ) {
        clientX =
            event.changedTouches[0].clientX;

        clientY =
            event.changedTouches[0].clientY;

    } else {
        clientX =
            event.clientX;

        clientY =
            event.clientY;
    }

    return {
        x: Math.max(
            0,
            Math.min(
                rect.width,
                clientX - rect.left
            )
        ),

        y: Math.max(
            0,
            Math.min(
                rect.height,
                clientY - rect.top
            )
        )
    };
}


function updateCropSelection() {
    const selection =
        $("imageCropSelection");

    const left =
        Math.min(
            imageCropState.startX,
            imageCropState.endX
        );

    const top =
        Math.min(
            imageCropState.startY,
            imageCropState.endY
        );

    const width =
        Math.abs(
            imageCropState.endX -
            imageCropState.startX
        );

    const height =
        Math.abs(
            imageCropState.endY -
            imageCropState.startY
        );

    selection.style.left =
        `${left}px`;

    selection.style.top =
        `${top}px`;

    selection.style.width =
        `${width}px`;

    selection.style.height =
        `${height}px`;

    selection.style.display =
        width > 2 && height > 2
            ? "block"
            : "none";
}


function startImageCrop(event) {
    event.preventDefault();

    const point =
        getCropPointerPosition(event);

    imageCropState.dragging = true;

    imageCropState.startX =
        point.x;

    imageCropState.startY =
        point.y;

    imageCropState.endX =
        point.x;

    imageCropState.endY =
        point.y;

    updateCropSelection();
}


function moveImageCrop(event) {
    if (!imageCropState.dragging) {
        return;
    }

    event.preventDefault();

    const point =
        getCropPointerPosition(event);

    imageCropState.endX =
        point.x;

    imageCropState.endY =
        point.y;

    updateCropSelection();
}


function endImageCrop(event) {
    if (!imageCropState.dragging) {
        return;
    }

    event.preventDefault();

    const point =
        getCropPointerPosition(event);

    imageCropState.endX =
        point.x;

    imageCropState.endY =
        point.y;

    imageCropState.dragging = false;

    updateCropSelection();
}


// =====================================
// Canvas → Blob
// =====================================

function canvasToBlob(
    canvas,
    type,
    quality
) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (!blob) {
                    reject(
                        new Error(
                            "사진 압축에 실패했습니다."
                        )
                    );

                    return;
                }

                resolve(blob);
            },
            type,
            quality
        );
    });
}


// =====================================
// Crop + 압축
// =====================================

async function createCroppedProblemImage() {
    const sourceImage =
        $("imageCropSource");

    const stage =
        $("imageCropStage");

    if (!sourceImage.naturalWidth) {
        throw new Error(
            "원본 사진을 읽지 못했습니다."
        );
    }

    const left =
        Math.min(
            imageCropState.startX,
            imageCropState.endX
        );

    const top =
        Math.min(
            imageCropState.startY,
            imageCropState.endY
        );

    const selectedWidth =
        Math.abs(
            imageCropState.endX -
            imageCropState.startX
        );

    const selectedHeight =
        Math.abs(
            imageCropState.endY -
            imageCropState.startY
        );

    if (
        selectedWidth < 30 ||
        selectedHeight < 30
    ) {
        throw new Error(
            "문제 범위를 조금 더 크게 선택해주세요."
        );
    }

    const stageRect =
        stage.getBoundingClientRect();

    const imageRect =
        sourceImage.getBoundingClientRect();

    /*
        object-fit: contain 때문에
        실제 이미지가 stage 전체를
        차지하지 않을 가능성을 고려한다.
    */

    // object-fit: contain은 이미지 박스에 내부 여백이 있을 수 있다.
    const imageBoxWidth = imageRect.width;
    const imageBoxHeight = imageRect.height;
    const fitScale = Math.min(
        imageBoxWidth / sourceImage.naturalWidth,
        imageBoxHeight / sourceImage.naturalHeight
    );
    const displayedWidth = sourceImage.naturalWidth * fitScale;
    const displayedHeight = sourceImage.naturalHeight * fitScale;
    const imageOffsetX = imageRect.left - stageRect.left +
        (imageBoxWidth - displayedWidth) / 2;
    const imageOffsetY = imageRect.top - stageRect.top +
        (imageBoxHeight - displayedHeight) / 2;

    const relativeLeft =
        Math.max(
            0,
            left - imageOffsetX
        );

    const relativeTop =
        Math.max(
            0,
            top - imageOffsetY
        );

    const relativeRight =
        Math.min(
            displayedWidth,
            left +
                selectedWidth -
                imageOffsetX
        );

    const relativeBottom =
        Math.min(
            displayedHeight,
            top +
                selectedHeight -
                imageOffsetY
        );

    const relativeWidth =
        relativeRight -
        relativeLeft;

    const relativeHeight =
        relativeBottom -
        relativeTop;

    if (
        relativeWidth <= 0 ||
        relativeHeight <= 0
    ) {
        throw new Error(
            "사진 안쪽의 문제 범위를 선택해주세요."
        );
    }

    const scaleX =
        sourceImage.naturalWidth /
        displayedWidth;

    const scaleY =
        sourceImage.naturalHeight /
        displayedHeight;

    const sourceX =
        relativeLeft * scaleX;

    const sourceY =
        relativeTop * scaleY;

    const sourceWidth =
        relativeWidth * scaleX;

    const sourceHeight =
        relativeHeight * scaleY;


    // =====================================
    // 출력 크기 제한
    // =====================================

    const MAX_LONG_SIDE = 1600;

    const longSide =
        Math.max(
            sourceWidth,
            sourceHeight
        );

    const outputScale =
        longSide > MAX_LONG_SIDE
            ? MAX_LONG_SIDE / longSide
            : 1;

    const outputWidth =
        Math.max(
            1,
            Math.round(
                sourceWidth *
                outputScale
            )
        );

    const outputHeight =
        Math.max(
            1,
            Math.round(
                sourceHeight *
                outputScale
            )
        );


    const canvas =
        document.createElement(
            "canvas"
        );

    canvas.width =
        outputWidth;

    canvas.height =
        outputHeight;

    const ctx =
        canvas.getContext("2d");

    if (!ctx) {
        throw new Error(
            "사진 처리 기능을 사용할 수 없습니다."
        );
    }

    ctx.imageSmoothingEnabled =
        true;

    ctx.imageSmoothingQuality =
        "high";

    ctx.drawImage(
        sourceImage,

        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,

        0,
        0,
        outputWidth,
        outputHeight
    );


    // =====================================
    // WebP 우선 압축
    // 33KB 강제 X
    // 가독성 우선
    // =====================================

    let quality = 0.82;

    let blob =
        await canvasToBlob(
            canvas,
            "image/webp",
            quality
        );

    /*
        목표는 대략적인 용량 절감이지
        33KB를 무조건 맞추는 게 아니다.

        120KB 이상이면 조금씩 품질을 낮춘다.
    */

    const TARGET_MAX_BYTES =
        120 * 1024;

    while (
        blob.size >
            TARGET_MAX_BYTES &&
        quality > 0.58
    ) {
        quality -= 0.06;

        blob =
            await canvasToBlob(
                canvas,
                "image/webp",
                quality
            );
    }


    return {
        blob,

        width:
            outputWidth,

        height:
            outputHeight,

        size:
            blob.size,

        type:
            blob.type ||
            "image/webp"
    };
}


// =====================================
// ScorePath 3장 사진: 여러 크롭을 하나의 고해상도 묶음 이미지로 저장
// R2 키 1개 / 기존 오답·복습·삭제 구조 그대로 사용
// 사진 사이 흰 여백으로 구역을 분리한다.
// =====================================
async function composeScorePathPhotoPartsV01(parts) {
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > 3) {
        throw new Error("사진은 1~3장만 첨부할 수 있습니다.");
    }

    const bitmaps = [];
    try {
        for (const part of parts) {
            if (!part?.blob || part.blob.size > 2 * 1024 * 1024) {
                throw new Error("사진 한 장은 2MB 이하로 준비해주세요.");
            }
            bitmaps.push(await createImageBitmap(part.blob));
        }
        const gap = 12;
        const rawWidth = Math.max(...bitmaps.map(image => image.width));
        const rawHeight = bitmaps.reduce((total, image) => total + image.height, 0)
            + gap * (bitmaps.length - 1);

        // 큰 사진을 무제한 허용하지 않는다. 비용과 안정성을 함께 고려.
        const scale = Math.min(
            1,
            4800 / rawHeight,
            Math.sqrt(6400000 / (rawWidth * rawHeight))
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(rawWidth * scale));
        canvas.height = Math.max(1, Math.round(rawHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("사진을 합칠 수 없습니다.");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        let top = 0;
        for (const image of bitmaps) {
            const height = image.height * scale;
            ctx.drawImage(image, 0, top, image.width * scale, height);
            top += height + gap * scale;
        }

        let blob = null;
        for (let quality = 0.86; quality >= 0.46; quality -= 0.08) {
            blob = await canvasToBlob(canvas, "image/webp", quality);
            if (blob.size <= 2 * 1024 * 1024) break;
        }
        if (!blob || blob.size > 2 * 1024 * 1024) {
            throw new Error("사진 묶음이 너무 큽니다. 필요한 범위만 선택해주세요.");
        }
        return { blob, width: canvas.width, height: canvas.height,
            size: blob.size, type: "image/webp" };
    } finally {
        for (const bitmap of bitmaps) bitmap.close?.();
    }
}

async function updateScorePathPhotoPartsV01(parts) {
    const result = parts.length
        ? await composeScorePathPhotoPartsV01(parts)
        : null;
    const old = selectedProblemImage?.previewUrl;
    scorePathPhotoPartsV01 = [...parts];
    selectedProblemImage = result
        ? { ...result, previewUrl: URL.createObjectURL(result.blob) }
        : null;
    selectedProblemImageKey = ""; // 수정된 묶음은 R2 재업로드
    if (old) URL.revokeObjectURL(old);
    renderSelectedProblemImage();
}

// =====================================
// 선택한 사진 미리보기
// =====================================

function renderSelectedProblemImage() {
    const box = $("problemImagePreviewBox");
    const preview = $("problemImagePreview");
    const info = $("problemImageInfo");
    if (!box || !preview) return;

    if (!selectedProblemImage) {
        box.hidden = true;
        preview.removeAttribute("src");
        if (info) info.textContent = "";
    } else {
        preview.src = selectedProblemImage.previewUrl;
        box.hidden = false;
        if (info) {
            const count = scorePathPhotoPartsV01.length || 1;
            info.textContent = `사진 ${count}/3장 · 한 문제만 허용 · 지문·그림·조건·선택지가 잘리지 않았는지 확인하세요.`;
        }
    }

    let thumbnails = $("scorePathPhotoThumbnailsV01");
    if (!thumbnails) {
        thumbnails = document.createElement("div");
        thumbnails.id = "scorePathPhotoThumbnailsV01";
        thumbnails.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-top:9px";
        box.appendChild(thumbnails);
    }
    thumbnails.replaceChildren();
    scorePathPhotoPartsV01.forEach((part, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary-btn";
        button.textContent = `사진 ${index + 1} 삭제`;
        button.onclick = async () => {
            try {
                await updateScorePathPhotoPartsV01(
                    scorePathPhotoPartsV01.filter((_, i) => i !== index)
                );
            } catch (error) {
                showMessage(error.message, "red");
            }
        };
        thumbnails.appendChild(button);
    });
    const pickButton = $("selectProblemImageBtn");
    if (pickButton) {
        pickButton.disabled = scorePathPhotoPartsV01.length >= 3;
        // 기존 저장 사진은 삭제한 뒤 새 사진 묶음을 시작해야 한다.
    }
}

async function confirmProblemImageCrop() {
    try {
        $("confirmImageCropBtn").disabled = true;
        $("imageLoadingText").textContent = "사진을 처리하는 중입니다...";
        const result = await createCroppedProblemImage();
        if (scorePathPhotoPartsV01.length >= 3) {
            throw new Error("사진은 최대 3장까지 첨부할 수 있습니다.");
        }
        // 저장된 사진을 불러온 상태라면 한 묶음에 섞지 않는다.
        if (selectedProblemImage && scorePathPhotoPartsV01.length === 0) {
            throw new Error("저장된 사진을 먼저 삭제한 뒤 새 사진을 추가해주세요.");
        }
        await updateScorePathPhotoPartsV01([...scorePathPhotoPartsV01, result]);
        $("imageCropModal").hidden = true;
        showMessage(
            `사진 ${scorePathPhotoPartsV01.length}/3장 준비 완료. 하나의 문제만 첨부해주세요.`,
            "green"
        );
    } catch (error) {
        showMessage(error.message || "사진 처리에 실패했습니다.", "red");
    } finally {
        $("confirmImageCropBtn").disabled = false;
        $("imageLoadingText").textContent = "";
    }
}

// =====================================
// Crop 취소
// =====================================

function cancelProblemImageCrop() {
    imageCropState.dragging =
        false;

    $("imageCropModal").hidden =
        true;

    $("imageCropSelection").style.display =
        "none";
}


// =====================================
// 사진 삭제
// =====================================

function removeSelectedProblemImage() {
    scorePathPhotoPartsV01 = [];
    if (
        selectedProblemImage
            ?.previewUrl
    ) {
        URL.revokeObjectURL(
            selectedProblemImage.previewUrl
        );
    }

    selectedProblemImage = null;
selectedProblemImageKey = "";

renderSelectedProblemImage();

    showMessage(
        "문제 사진을 삭제했습니다.",
        "blue"
    );
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
            password: $("registerPassword").value,
                    age14Confirmed: $("registerAge14Confirmed")?.checked === true
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
        const data =
            await api(
                "/api/auth/login",
                "POST",
                {
                    email:
                        $("loginEmail").value,

                    password:
                        $("loginPassword").value
                }
            );

        $("authCard").hidden = true;
        $("appShell").hidden = false;

        clearInputs();

        currentAnalysisState = null;
        activeModeState = null;

        renderDashboard(
            data.dashboard
        );

        showMessage(
            data.message,
            "green"
        );

    } catch (error) {
        showAuthMessage(
            error.message,
            "red"
        );
    }
}

async function logout() {

    // =====================================
    // ScorePath 21-140
    // 계정별 화면 상태 초기화
    // =====================================

    // 1. 서버 로그아웃
    try {

        await api(
            "/api/auth/logout",
            "POST"
        );

    } catch (error) {

        // 서버 로그아웃 실패 시
        // 성공했다고 표시하지 않는다.
        alert(
            error?.message ||
            "서버 로그아웃에 실패했습니다. 다시 시도해 주세요."
        );

        return;
    }

    // =====================================
    // 2. 이전 계정의 임시 화면 제거
    // =====================================

    // 기존 문제은행 팝업
    $("scorePathBankOverlay")?.remove();

    // 진행 중이던 학습 완료 버튼
    $("scorePathStudyCompleteV01")?.remove();

    // 시험 미등록 안내
    $("scorePathHomeEmptyV01")?.remove();

    // 사진 범위 선택 창
    if ($("imageCropModal")) {

        $("imageCropModal").hidden = true;
    }

    // =====================================
    // 3. 시험 선택 정보 초기화
    // =====================================

    scorePathLastExamV01 = null;

    selectedExamState = null;

    const shell =
        $("appShell");

    if (shell) {

        // =====================================
        // ScorePath 21-149
        // 로그아웃 시 계정별 UI 상태 초기화
        // =====================================

        // 기존 시험 선택 소유자 정보
        delete shell.dataset
            .scorepathExamOwnerV01;

        // 학습 복원 실행 여부
        delete shell.dataset
            .scorepathRestoreOwnerV01;
    }

    // =====================================
    // 4. 기존 사용자 상태 초기화
    // =====================================

    dashboardState = null;

    currentAnalysisState = null;

    activeModeState = null;

    clearInputs();

    // =====================================
    // 5. 다음 로그인 기본 화면
    // =====================================

    setScorePathMainNavigationV01(
        "home"
    );

    // =====================================
    // 6. 로그인 화면으로 복귀
    // =====================================

    $("authCard").hidden = false;

    $("appShell").hidden = true;

    showAuthMessage(
        "로그아웃되었습니다.",
        "blue"
    );
}

// =====================================
// ScorePath V1
// 매일 자동 전광판 업데이트
// =====================================

// 마지막으로 갱신한 날짜
let scorePathBoardLastDayV01 = "";

// 중복 요청 방지
let scorePathBoardRefreshingV01 = false;

// 오류 발생 시 재시도 시간
let scorePathBoardRetryAtV01 = 0;


// =====================================
// 사용자 기준 오늘 날짜
// =====================================

function getScorePathLocalDayV01() {

    const now = new Date();

    return [
        now.getFullYear(),

        String(
            now.getMonth() + 1
        ).padStart(2, "0"),

        String(
            now.getDate()
        ).padStart(2, "0")

    ].join("-");
}


// =====================================
// 날짜가 바뀌면 전광판 업데이트
// =====================================

async function refreshScorePathDailyBoardV01() {

    // 로그인 상태가 아니면 실행하지 않음
    if (
        !dashboardState ||
        $("appShell")?.hidden
    ) {
        return;
    }

    // 화면을 보고 있지 않으면 대기
    if (document.hidden) {
        return;
    }

    // 홈에서 전광판을 볼 때 갱신
    const currentTab =
        document.documentElement.dataset
            .scorepathMainTab;

    if (currentTab !== "home") {
        return;
    }

    // 시험 대비 문제풀이 중에는
    // 화면을 변경하지 않는다.
    if (
        $("examStudyView")?.hidden === false
    ) {
        return;
    }

    const today =
        getScorePathLocalDayV01();

    // 오늘 이미 갱신했다면 종료
    if (
        scorePathBoardLastDayV01 === today
    ) {
        return;
    }

    // 중복 요청 방지
    if (scorePathBoardRefreshingV01) {
        return;
    }

    // 오류 발생 시 10분 후 재시도
    if (
        Date.now() <
        scorePathBoardRetryAtV01
    ) {
        return;
    }

    const account =
        String(
            dashboardState.user?.id ||
            dashboardState.user?.email ||
            ""
        );

    if (!account) {
        return;
    }

    scorePathBoardRefreshingV01 = true;

    scorePathBoardRetryAtV01 =
        Date.now() + 10 * 60 * 1000;

    try {

        // =====================================
        // 1. 최신 학습 기록 불러오기
        // =====================================

        const data =
            await api("/api/auth/me");

        const currentAccount =
            String(
                dashboardState?.user?.id ||
                dashboardState?.user?.email ||
                ""
            );

        const responseAccount =
            String(
                data.dashboard?.user?.id ||
                data.dashboard?.user?.email ||
                ""
            );

        // 요청 중 계정이 바뀌었다면 중단
        if (
            account !== currentAccount ||
            account !== responseAccount ||
            $("appShell")?.hidden
        ) {
            return;
        }

        // =====================================
        // 2. 기존 전광판 데이터 갱신
        // =====================================

        renderDashboard(
            data.dashboard
        );

        // =====================================
        // 3. 시험 모드 전광판 갱신
        // =====================================

        const examId =
            selectedExamState?.examId;

        if (
            examId &&
            document.documentElement.dataset
                .scorepathMainTab === "home"
        ) {

            // 기존 시험 API 활용
            const examData =
                await api("/api/exams");

            const exams =
                Array.isArray(examData.exams)
                    ? examData.exams
                    : [];

            const exam =
                exams.find(
                    item =>
                        String(item.id) ===
                        String(examId)
                );

            if (!exam) {

                throw new Error(
                    "선택한 시험의 최신 정보를 찾지 못했습니다."
                );
            }

            // 요청 중 시험 모드를 껐다면
            // 이전 시험 화면을 다시 표시하지 않음
            if (
                String(
                    selectedExamState?.examId || ""
                ) === String(examId) &&

                document.documentElement.dataset
                    .scorepathMainTab === "home"
            ) {

                const riskProfile =
                    exam.riskProfile || {};

                const rangeStatus =
                    exam.rangeStatus || {};

                selectedExamState = {
                    examId: exam.id,
                    exam,
                    riskProfile,
                    rangeStatus
                };

                // 기존 시험 전광판 함수 재사용
                renderExamRisk(
                    exam,
                    riskProfile,
                    rangeStatus,
                    exam.unitStats || []
                );

                // ON/OFF 버튼 상태 갱신
                if (
                    typeof setupScorePathExamModeSwitchV01
                        === "function"
                ) {

                    setupScorePathExamModeSwitchV01();
                }
            }
        }

        // =====================================
        // 4. 갱신 성공 날짜 기록
        // =====================================

        scorePathBoardLastDayV01 =
            today;

        scorePathBoardRetryAtV01 = 0;

        console.log(
            "ScorePath 전광판 자동 갱신:",
            today
        );

    } catch (error) {

        // 기존 전광판은 그대로 유지
        console.warn(
            "전광판 자동 갱신 실패:",
            error
        );

    } finally {

        scorePathBoardRefreshingV01 =
            false;
    }
}


// =====================================
// 기존 로그인 상태 확인
// =====================================

async function loadMe() {

    try {

        const data =
            await api("/api/auth/me");

        $("authCard").hidden = false;
        $("appShell").hidden = false;

        $("authCard").hidden = true;

        clearInputs();

        currentAnalysisState = null;
        activeModeState = null;

        // 기존 대시보드 불러오기
        renderDashboard(
            data.dashboard
        );

        // 최초 로그인은 이미
        // 최신 데이터를 불러온 상태
        scorePathBoardLastDayV01 =
            getScorePathLocalDayV01();

        scorePathBoardRetryAtV01 = 0;

    } catch (error) {

        $("authCard").hidden = false;
        $("appShell").hidden = true;
    }
}

async function addSubject() {
    const subject = $("newSubjectInput").value.trim();

    if (!subject) {
        showMessage("추가할 과목을 입력해주세요.", "red");
        return;
    }

    try {
        const data = await api("/api/subjects/add", "POST", {
            subject
        });

        renderDashboard(data.dashboard);

        // 방금 추가한 과목 자동 선택
        if (data.subjects.includes(subject)) {
            $("subject").value = subject;
        }

        $("newSubjectInput").value = "";
        showMessage(data.message, "green");

    } catch (error) {
        showMessage(error.message, "red");
    }
}


async function deleteSubject() {
    const subject = $("subject").value;

    if (!subject) {
        showMessage("삭제할 과목을 선택해주세요.", "red");
        return;
    }

    const ok = confirm(`'${subject}' 과목을 삭제할까요?`);

    if (!ok) return;

    try {
        const data = await api("/api/subjects/delete", "POST", {
            subject
        });

        renderDashboard(data.dashboard);
        showMessage(data.message, "blue");

    } catch (error) {
        showMessage(error.message, "red");
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
    // Luna와 Terra를 같은 탭에서 동시에 실행하지 않는다.
    if (isAnalyzeRequestRunning || isAdvancedProblemGeneratingV01) {
        console.warn(
            "중복 AI 분석 요청 차단"
        );
        return;
    }

    const subject =
        $("subject").value;

    const problem =
        $("problem").value.trim();

    // 모르면 AI에게 풀이를 요청할 수 있다. 채점 결과로 확정하지 않는다.
    const userAnswer =
        $("userAnswer").value.trim() || "모르겠어요";

    // =====================================
    // ScorePath 21-351
    // 유사문제 채점 후 선택적 AI 분석
    // =====================================

    const correctAnswer =
        $("correctAnswer").value.trim() ||
        (
            activeModeState?.type === "similar"
                ? String(
                    activeModeState.checkedCorrectAnswer || ""
                ).trim()
                : ""
        );

    const hasProblemImage =
    Boolean(
        selectedProblemImage?.blob
    );

    /*
     * 문제는
     * 1) 직접 입력한 텍스트
     * 또는
     * 2) 선택/크롭한 사진
     *
     * 둘 중 하나만 있으면 된다.
     */
    if (
        !subject ||
        (!problem && !hasProblemImage) ||
        !userAnswer
    ) {
        showMessage(
            "과목과 문제(또는 사진)를 입력해주세요. 정답을 몰라도 AI 분석이 가능합니다.",
            "red"
        );

        return;
    }

    const rule =
        getCurrentPlanRule();

    /*
    if (!rule.duplicateAnalyze) {
        const exists =
            (
                dashboardState?.wrongNotes ||
                []
            ).some(
                (note) =>
                    note.subject === subject &&
                    note.problem === problem &&
                    note.correctAnswer === correctAnswer
            );

        if (exists) {
            showMessage(
                "무료 요금제에서는 같은 문제를 다시 분석할 수 없습니다.",
                "red"
            );

            return;
        }
    }
    */

    // await 이전에 잠금부터 건다.
    isAnalyzeRequestRunning = true;

    const otherAiButton = $("generateAdvancedBtn");
    if (otherAiButton) otherAiButton.disabled = true;
    setLoading(true);

    showMessage(
        hasProblemImage
            ? "문제 사진을 준비하고 AI 분석 중입니다..."
            : "AI 분석 중입니다...",
        "blue"
    );

    console.log(
        "분석 직전 activeModeState:",
        activeModeState
    );

    try {
        console.log(
            "AI 분석 요청 시작"
        );

        let problemImageBase64 = "";
        let problemImageContentType = "";
        let problemImageKey = "";

        /*
         * 사진 문제일 때만 실행.
         *
         * 같은 압축 Blob을
         * - R2 저장
         * - Gemini 분석
         * 두 곳에서 사용한다.
         */
        if (hasProblemImage) {
            problemImageBase64 =
                await blobToDataUrl(
                    selectedProblemImage.blob
                );

            problemImageContentType =
                selectedProblemImage.blob.type ||
                "image/webp";

            /*
             * R2에는 한 번만 업로드한다.
             */
            if (selectedProblemImageKey) {
    problemImageKey =
        selectedProblemImageKey;

    console.log(
        "기존 R2 문제 사진 재사용:",
        problemImageKey
    );

} else {
    const uploadResult =
        await uploadSelectedProblemImage();

    problemImageKey =
        uploadResult
            ?.problemImageKey ||
        "";

    if (!problemImageKey) {
        throw new Error(
            "문제 사진 저장에 실패했습니다."
        );
    }

    selectedProblemImageKey =
        problemImageKey;
}

selectedProblemImageKey =
    problemImageKey;

            console.log(
                "분석용 문제 사진 준비 완료:",
                {
                    problemImageKey,
                    contentType:
                        problemImageContentType
                }
            );
        }

        const data =
            await api(
                "/api/analyze",
                "POST",
                {
                    subject,

                    /*
                     * 사진만 입력한 경우에는
                     * 빈 문자열 그대로 전송한다.
                     * 이미지 자체가 문제 원본이다.
                     */
                    problem,

                    userAnswer,
                    correctAnswer,
                    generatedProblemId:
                        activeModeState?.type === "similar"
                            ? (activeModeState.generatedProblemId || "")
                            : "",

                    problemImageBase64,
                    problemImageContentType,
                    problemImageKey,
                    photoCount: scorePathPhotoPartsV01.length || (hasProblemImage ? 1 : 0),

                    sourceType:
                        activeModeState?.type ||
                        "normal"
                }
            );

        currentAnalysisState =
            data.analysis;

        renderDashboard(
            data.dashboard
        );

        applyPlanToCurrentAnalysis();

        showMessage(
            data.message,
            "green"
        );

        // 분석 완료 후
        // AI 분석 결과로 자동 이동
        requestAnimationFrame(() => {
            const resultSection =
                document.querySelector(
                    "#verificationBox"
                );

            if (resultSection) {
                resultSection.scrollIntoView({
                    behavior: "smooth",
                    block: "start"
                });
            }
        });

    } catch (error) {
        currentAnalysisState = null;

        renderCurrentAnalysis();
        updateModeUI();

        if (
            error.verification ===
            "uncertain"
        ) {
            showMessage(
                "AI가 문제의 정답을 확실하게 검증하지 못했습니다. 문제 또는 입력한 정답을 다시 확인해 주세요. 분석 횟수는 차감되지 않았습니다.",
                "red"
            );

            return;
        }

        showMessage(
            error.message,
            "red"
        );

    } finally {
        // 성공/실패/uncertain 관계없이
        // 요청이 완전히 끝난 뒤에만 잠금 해제
        isAnalyzeRequestRunning = false;
        const otherAiButton = $("generateAdvancedBtn");
        if (otherAiButton) otherAiButton.disabled = isAdvancedProblemGeneratingV01;
        setLoading(false);

        console.log(
            "AI 분석 요청 종료"
        );
    }
}

// =====================================
// ScorePath 21-365
// 응용문제 생성 중복 요청 방지
// =====================================

let isAdvancedProblemGeneratingV01 = false;

async function generateAdvancedProblem() {

    // Luna 분석이 진행 중이거나 Terra 생성 중이면 차단한다.
    if (isAdvancedProblemGeneratingV01 || isAnalyzeRequestRunning) {
        return;
    }

    const subject = $("subject").value;
    const problem = $("problem").value.trim();
    const imageBlob = selectedProblemImage?.blob || null;

    if (!problem && !imageBlob) {
        showMessage(
            "문제 내용이나 문제 사진을 먼저 입력해주세요.",
            "red"
        );
        return;
    }

    // =====================================
    // 응용문제 생성 시작 - 버튼 잠금
    // =====================================

    isAdvancedProblemGeneratingV01 = true;
    const otherAiButton = $("analyzeBtn");
    if (otherAiButton) otherAiButton.disabled = true;

    const generateBtn = $("generateAdvancedBtn");

    // 응용문제 버튼 바로 아래에 상태 표시
    let advancedStatus =
        $("scorePathAdvancedStatusV01");

    if (generateBtn && !advancedStatus) {

        advancedStatus =
            document.createElement("div");

        advancedStatus.id =
            "scorePathAdvancedStatusV01";

        advancedStatus.style.cssText =
            "margin-top:8px;" +
            "font-size:13px;" +
            "white-space:pre-wrap;";

        advancedStatus.setAttribute(
            "role",
            "status"
        );

        advancedStatus.setAttribute(
            "aria-live",
            "polite"
        );

        generateBtn.insertAdjacentElement(
            "afterend",
            advancedStatus
        );
    }

    const showAdvancedStatus = (message, color) => {

        if (!advancedStatus) return;

        advancedStatus.textContent = message;
        advancedStatus.style.color = color;
    };

    const originalButtonText =
        generateBtn?.textContent || "응용문제 생성";

    if (generateBtn) {

        generateBtn.disabled = true;

        generateBtn.textContent =
            "응용문제 생성 중...";

        generateBtn.setAttribute(
            "aria-busy",
            "true"
        );
    }

    try {

        showAdvancedStatus(
            "응용문제 생성 요청 중...",
            "#2563eb"
        );

        showMessage(
            "응용문제를 생성 중입니다...",
            "blue"
        );

        let problemImageKey = selectedProblemImageKey || "";
        let problemImageBase64 = "";
        let problemImageContentType = "";

        // 기존 R2 업로드 기능 재사용
        if (imageBlob) {

            if (!problemImageKey) {

                const upload =
                    await uploadSelectedProblemImage();

                problemImageKey = String(
                    upload?.problemImageKey || ""
                ).trim();

                if (!problemImageKey) {
                    throw new Error(
                        "문제 사진 저장에 실패했습니다."
                    );
                }

                selectedProblemImageKey = problemImageKey;
            }

            // 기존 사진 데이터를 그대로 전달
            problemImageBase64 =
                await blobToDataUrl(imageBlob);

            problemImageContentType =
                imageBlob.type || "image/webp";
        }

        const data = await api(
            "/api/advanced-problem",
            "POST",
            {
                subject,
                problem,
                problemImageKey,
                problemImageBase64,
                problemImageContentType,
                photoCount: scorePathPhotoPartsV01.length || (imageBlob ? 1 : 0)
            }
        );

        if (!currentAnalysisState) {

            currentAnalysisState = {
                aiAnswer: "",
                verification: "uncertain",
                warning: "",
                reason: "아직 분석 결과가 없습니다.",
                concept: "아직 분석 결과가 없습니다.",
                solution: "아직 분석 결과가 없습니다.",
                similarProblems: [],
                advancedProblem: data.advancedProblem
            };

        } else {

            currentAnalysisState.advancedProblem =
                data.advancedProblem;
        }

        renderDashboard(data.dashboard);
        applyPlanToCurrentAnalysis();

        showAdvancedStatus(
            data.message || "응용문제 생성 완료",
            "#15803d"
        );

        showMessage(
            data.message,
            "green"
        );

    } catch (error) {

        const message =
            error?.message ||
            "응용문제 요청이 실패했습니다.";

        showAdvancedStatus(
            message,
            "#dc2626"
        );

        showMessage(
            message,
            "red"
        );

        console.error(
            "응용문제 생성 요청 실패:",
            error
        );

    } finally {

        // =====================================
        // 생성 성공 / 실패 시 버튼 잠금 해제
        // =====================================

        isAdvancedProblemGeneratingV01 = false;
        const otherAiButton = $("analyzeBtn");
        if (otherAiButton) otherAiButton.disabled = isAnalyzeRequestRunning;

        const currentBtn =
            $("generateAdvancedBtn") || generateBtn;

        if (currentBtn) {

            currentBtn.disabled = false;

            currentBtn.textContent =
                originalButtonText;

            currentBtn.removeAttribute(
                "aria-busy"
            );
        }
    }
}

async function checkAnswer() {
    const subject =
        $("subject").value;

    const problem =
        $("problem").value.trim();

    const userAnswer =
        $("userAnswer").value.trim();

    const correctAnswer =
        $("correctAnswer").value.trim();

    const sourceType =
        activeModeState?.type ||
        "normal";
// =====================================
// ScorePath - 현재 시험 / 학습 범위
// =====================================

// =====================================
// ScorePath 21-262
// 일반 / 시험 모드 학습 기록 통합
// =====================================

// =====================================
// 1. 현재 시험 확인
// =====================================

const scorePathExamId =
    $("scorePathExam")
        ?.value
        ?.trim() || "";

// =====================================
// 2. 시험 모드인지 확인
// =====================================

const isExamMode =
    Boolean(scorePathExamId);

// =====================================
// 3. 현재 공부 단원 가져오기
// =====================================

let scorePathUnit = "";

// 시험 모드
if (isExamMode) {

    scorePathUnit =
        $("scorePathUnit")
            ?.value
            ?.trim() || "";

}

// 일반 모드
else {

    scorePathUnit =
        $("scorePathGeneralUnit")
            ?.value
            ?.trim() || "";

}

// =====================================
// 4. 일반 모드 단원명 정리
// =====================================

if (!isExamMode) {

    scorePathUnit =
        scorePathUnit
            .replace(/\s+/g, " ")
            .trim();
}

// =====================================
// 5. 기존 문제풀이 API에서 활용
// =====================================

// scorePathExamId가 비어 있으면 일반 모드
// scorePathExamId가 있으면 시험 모드

// scorePathUnit은 기존 정답 확인 API에 전달
// 기존 문제풀이 및 사진 저장 기능은 유지

// =====================================
// ScorePath 21-199
// 진행 중인 학습의 기록 누락 방지
// =====================================

const activeStudyButton =
    $("scorePathStudyCompleteV01");

if (
    sourceType === "normal" &&
    activeStudyButton &&
    !activeStudyButton.hidden
) {

    try {

        // 서버에서 실제 진행 중인 학습 확인
        const activeData = await api(
            "/api/scorepath/study/active"
        );

        const active = activeData.active === true
            ? activeData.session
            : null;

        // =====================================
        // ScorePath 21-273
        // 실제 서버 학습 상태 확인
        // =====================================

        // =====================================
        // 1. 진행 중인 시험 공부가 없는 경우
        // =====================================

        if (!active) {

            // 이미 완료하거나 취소한 시험의
            // 오래된 완료 버튼만 제거한다.
            activeStudyButton.remove();

            // 실제 진행 중인 시험 공부가 없으므로
            // 기존 정답 확인 과정으로 계속 진행한다.

        }

        // =====================================
        // 2. 진행 중인 시험 공부가 있는 경우
        // =====================================

        else if (

            String(active.examId) !==
                String(scorePathExamId) ||

            String(active.unit) !==
                String(scorePathUnit)

        ) {

            showMessage(
                "진행 중인 시험 공부와 " +
                "현재 선택한 시험·단원이 다릅니다. " +
                "기존 학습을 완료하거나 취소해주세요.",
                "red"
            );

            // 홈에서 기존 시험 공부를
            // 바로 확인할 수 있도록 안내 갱신
            if (
                typeof refreshScorePathPendingExamNoticeV01 ===
                "function"
            ) {

                void refreshScorePathPendingExamNoticeV01();
            }

            return;
        }

    } catch (error) {

        showMessage(
            error.message ||
            "학습 정보를 확인할 수 없습니다.",
            "red"
        );

        return;
    }
}

    // ================================
    // 예약 복습
    // ================================

    if (
        sourceType ===
        "scheduled_review"
    ) {
        if (
            !userAnswer ||
            !activeModeState?.reviewAttemptId
        ) {
            showMessage(
                "내 답을 입력해주세요.",
                "red"
            );

            return;
        }

        try {
            const data =
                await api(
                    "/api/reviews/check",
                    "POST",
                    {
                        reviewAttemptId:
                            activeModeState
                                .reviewAttemptId,

                        userAnswer
                    }
                );

            if (data.dashboard) {
                renderDashboard(
                    data.dashboard
                );
            }

            showMessage(
                data.message,
                data.isCorrect === true
                    ? "green"
                    : "red"
            );

            if (!data.duplicate) {
                $("problem").value = "";
                $("userAnswer").value = "";
                $("correctAnswer").value = "";

                currentAnalysisState = null;

                clearActiveMode();

                renderCurrentAnalysis();
            }

            return;

        } catch (error) {
            showMessage(
                error.message,
                "red"
            );

            return;
        }
    }


    // ================================
    // 약점 훈련
    // ================================

    if (
        sourceType ===
        "weakness_training"
    ) {
        if (
            !userAnswer ||
            !activeModeState
                ?.trainingAttemptId
        ) {
            showMessage(
                "내 답을 입력해주세요.",
                "red"
            );

            return;
        }

        try {
            const data =
                await api(
                    "/api/training/check",
                    "POST",
                    {
                        trainingAttemptId:
                            activeModeState
                                .trainingAttemptId,

                        userAnswer
                    }
                );

            if (data.dashboard) {
                renderDashboard(
                    data.dashboard
                );
            }

            showMessage(
                data.message,
                data.isCorrect === true
                    ? "green"
                    : "red"
            );

            if (!data.duplicate) {
                $("problem").value = "";
                $("userAnswer").value = "";
                $("correctAnswer").value = "";

                currentAnalysisState = null;

                clearActiveMode();

                renderCurrentAnalysis();
            }

            return;

        } catch (error) {
            showMessage(
                error.message,
                "red"
            );

            return;
        }
    }


    // ================================
    // 기존 일반 / 유사 / 응용 문제
    // ================================

        // =====================================
    // ScorePath 21-92
    // 저장된 사진 문제의 채점 허용
    // =====================================

    if (
        !subject ||
       (
    !problem &&
    !selectedProblemImageKey &&
    !selectedProblemImage?.blob
) ||
        !userAnswer ||
        (
            sourceType !== "similar" &&
            !correctAnswer
        )
    ) {
        showMessage(
            sourceType === "similar"
                ? "과목, 문제 또는 저장된 사진, 내 답을 입력해주세요."
                : "과목, 문제 또는 저장된 사진, 내 답, 정답을 모두 입력해주세요.",
            "red"
        );

        return;
    }

       try {

        // =====================================
        // ScorePath
        // 정답 확인 시 문제 사진 자동 저장
        // =====================================

        // 사진을 선택했지만 아직 저장하지 않았다면
        if (
            selectedProblemImage?.blob &&
            !selectedProblemImageKey
        ) {

            showMessage(
                "문제 사진 저장 중입니다...",
                "blue"
            );

            // 기존 R2 업로드 함수 재사용
            const uploaded =
                await uploadSelectedProblemImage();

            const imageKey =
                String(
                    uploaded?.problemImageKey || ""
                ).trim();

            if (!imageKey) {

                throw new Error(
                    "사진 저장에 실패했습니다. 다시 시도해주세요."
                );

            }

            // 업로드한 사진의 저장 키 유지
            selectedProblemImageKey =
                imageKey;

        }

        // =====================================
        // 기존 정답 확인 API
        // =====================================

        const data =
            await api(
                "/api/notes/check",
                "POST",
                {
    subject,
    problem,
    userAnswer,
    correctAnswer,

    problemImageKey:
        selectedProblemImageKey,

examId: scorePathExamId,
unit: scorePathUnit,

    currentAnalysis:
        currentAnalysisState,

                    sourceType:
                        activeModeState?.type ||
                        "normal",

                    generatedProblemId:
                        activeModeState
                            ?.generatedProblemId ||
                        ""
                }
            );

        // =====================================
        // ScorePath 21-14
        // 채점 후 학습 추천 자동 갱신
        // =====================================

        // =====================================
        // ScorePath 21-141
        // 채점 후 학습 화면 유지
        // =====================================

        // =====================================
        // ScorePath V1
        // 문제풀이 전후 추천 비교
        // =====================================

        const examModeActive =
            Boolean(
                selectedExamState?.examId
            );

        // =====================================
        // 현재 추천 읽기
        // =====================================

        const readCurrentRecommendation = () => {

            // 시험 모드
            if (examModeActive) {

                const nextStudy =
                    selectedExamState?.exam
                        ?.learningBoard
                        ?.nextStudy;

                if (!nextStudy?.unit) {
                    return "";
                }

                const unit =
                    String(nextStudy.unit);

                const minutes =
                    Number(nextStudy.minutes);

                return Number.isFinite(minutes)
                    ? `${unit} · ${minutes}분`
                    : unit;
            }

            // 일반 모드
            const title =
                $("scorePathGeneralBoardV01")
                    ?.querySelector(
                        "[data-general-title]"
                    );

            return (
                title?.textContent || ""
            ).trim();
        };

        // 기존 추천 저장
        const recommendationBefore =
            readCurrentRecommendation();

        // =====================================
        // 현재 시험과 풀이 연결 확인
        // =====================================

        const examLinkedCorrectly =
            !examModeActive ||
            (
                Boolean(scorePathExamId) &&
                String(scorePathExamId) ===
                String(selectedExamState.examId)
            );

        const shouldRefreshExam =
            examModeActive &&
            examLinkedCorrectly &&

            document.documentElement.dataset
                .scorepathMainTab === "home" &&

            $("examRiskView")?.hidden === false;

        // =====================================
        // 기존 대시보드 갱신
        // =====================================

        if (data.dashboard) {

            renderDashboard(
                data.dashboard
            );
        }

        // =====================================
        // ScorePath 21-352
        // 유사문제 생성 정답 연결 및 경고 안내
        // =====================================

        if (
            sourceType === "similar" &&
            activeModeState?.type === "similar"
        ) {

            // 이미 받은 대시보드 데이터를 사용한다.
            // 이 과정에서 추가 API 호출은 발생하지 않는다.

            const savedNotes = [
                ...(
                    Array.isArray(
                        data.dashboard?.wrongNotes
                    )
                        ? data.dashboard.wrongNotes
                        : []
                ),

                ...(
                    Array.isArray(
                        data.dashboard?.solvedNotes
                    )
                        ? data.dashboard.solvedNotes
                        : []
                )
            ];

            const savedSimilar = savedNotes.find(
                (note) =>
                    note?.sourceType === "similar" &&
                    String(note.problem || "") === problem
            );

            if (savedSimilar?.correctAnswer) {

                activeModeState.checkedCorrectAnswer =
                    String(
                        savedSimilar.correctAnswer
                    );
            }
        }

        // =====================================
        // 채점 결과 표시
        // =====================================

        showMessage(
            sourceType === "similar"

                ? `${data.message} ※ AI가 생성한 정답 기준으로 채점했으며, 오류 가능성이 있습니다. 필요하면 [AI 분석하기]로 별도 분석할 수 있습니다(요금제 사용량이 차감될 수 있음).`

                : data.message,

            data.isCorrect === true
                ? "green"
                : "red"
        );

        // =====================================
        // ScorePath 21-181
        // 채점 후 다음 행동 안내
        // =====================================

        const nextHint =
            $("scorePathStudyNextHintV01");

        if (nextHint) {

            const resultGuide =
                data.duplicate

                    ? "이미 기록된 문제입니다. " +
                      "다른 문제로 실력을 확인하세요."

                    : data.isCorrect === true

                        ? "정답이에요. 다른 유형의 " +
                          "새 문제도 풀어보세요."

                        : "틀린 개념을 복습하고 " +
                          "새로운 문제로 다시 확인하세요.";

            // 진행 중인 공부 완료 버튼 확인
            const completeButton =
                $("scorePathStudyCompleteV01");

            const completionGuide =
                completeButton &&
                !completeButton.hidden

                    ? " 공부를 마쳤다면 " +
                      "[공부 완료]를 눌러주세요."

                    : "";

            nextHint.textContent =
                resultGuide +
                completionGuide;
        }

        // 3. 기존 입력창 초기화
        if (data.clearInputs) {
            clearInputs();
        }

           // =====================================
        // ScorePath V1
        // 학습 후 전광판 추천 갱신
        // =====================================

        let examRefreshSucceeded =
            !shouldRefreshExam;

        // =====================================
        // 1. 시험 모드 추천 갱신
        // =====================================

        if (shouldRefreshExam) {

            try {

                const opened =
                    await openExamRisk(
                        scorePathExamId
                    );

                examRefreshSucceeded =
                    opened === true;

            } catch (refreshError) {

                examRefreshSucceeded = false;

                console.warn(
                    "추천 화면 갱신 실패:",
                    refreshError
                );
            }
        }

        // =====================================
        // 2. 추천 변경 여부 확인
        // =====================================

        if (
            data.dashboard &&
            !data.duplicate
        ) {

            const recommendationAfter =
                readCurrentRecommendation();

            let recommendationMessage = "";

            // 시험 모드 연결 오류
            if (
                examModeActive &&
                !examLinkedCorrectly
            ) {

                recommendationMessage =
                    "⚠️ 이번 문제는 현재 시험에 " +
                    "연결되지 않았습니다. " +
                    "시험과 단원을 확인해 주세요.";

            // 시험 전광판 갱신 실패
            } else if (
                shouldRefreshExam &&
                !examRefreshSucceeded
            ) {

                recommendationMessage =
                    "⚠️ 문제 기록은 저장됐지만 " +
                    "시험 전광판 갱신에 실패했습니다.";

            // 추천 비교 성공
            } else if (
                recommendationBefore &&
                recommendationAfter
            ) {

                if (
                    recommendationBefore ===
                    recommendationAfter
                ) {

                    recommendationMessage =
                        "📊 추천 유지: " +
                        recommendationAfter;

                } else {

                    recommendationMessage =
                        "🔄 추천 변경: " +
                        recommendationBefore +
                        " → " +
                        recommendationAfter;
                }

            } else {

                recommendationMessage =
                    "📊 학습 기록이 반영됐습니다. " +
                    "추천 비교를 위한 정보가 " +
                    "아직 부족합니다.";
            }

            // =====================================
            // 3. 기존 학습 안내에 결과 추가
            // =====================================

            const nextHint =
                $("scorePathStudyNextHintV01");

            if (nextHint) {

                const previousText =
                    nextHint.textContent.trim();

                nextHint.textContent =
                    previousText
                        ? previousText +
                          "\n\n" +
                          recommendationMessage

                        : recommendationMessage;
            }

            // =====================================
            // 4. 개발 테스트 기록
            // =====================================

            console.info(
                "ScorePath 추천 갱신 확인:",
                {
                    mode:
                        examModeActive
                            ? "exam"
                            : "general",

                    before:
                        recommendationBefore,

                    after:
                        recommendationAfter,

                    examLinked:
                        examLinkedCorrectly,

                    examRefreshed:
                        examRefreshSucceeded,

                    result:
                        recommendationMessage
                }
            );
        }
        // =====================================
        // ScorePath 21-333
        // 정답 확인 직후 검증 개수 갱신
        // =====================================

        if (
            sourceType === "normal" &&
            scorePathExamId &&
            scorePathUnit
        ) {

            try {

                const progress = await api(
                    "/api/scorepath/study/verification-progress"
                );

                const button =
                    $("scorePathStudyCompleteV01");

                if (
                    progress.active === true &&
                    progress.verificationRequired === true &&

                    String(progress.examId) ===
                        String(scorePathExamId) &&

                    String(progress.unit) ===
                        String(scorePathUnit) &&

                    button &&

                    (
                        !button.dataset.sessionId ||

                        String(button.dataset.sessionId) ===
                            String(progress.sessionId)
                    )
                ) {

                    const checked = Math.max(
                        0,
                        Number(
                            progress.newUniqueAttempts
                        ) || 0
                    );

                    button.dataset.sessionId =
                        String(progress.sessionId);

                    // 검증 개수 즉시 반영
                    button.textContent =
                        `🧪 검증 결과 확인 (${checked}/3)`;

                    const hint =
                        $("scorePathStudyNextHintV01");

                    if (hint) {

                        const remaining =
                            Math.max(0, 3 - checked);

                        hint.textContent +=
                            `\n🧪 검증 ${checked}/3개 인정` +

                            (
                                remaining > 0

                                    ? ` · 새 문제 ${remaining}개 더 필요`

                                    : " · 검증 결과 확인을 눌러 완료하세요."
                            );

                        // 기존 문제 또는 반복 문제 제외 안내
                        if (
                            Number(
                                progress.excludedPreviouslySolved
                            ) > 0 ||

                            Number(
                                progress.excludedRepeated
                            ) > 0
                        ) {

                            hint.textContent +=
                                "\n※ 기존 문제 또는 반복 풀이 기록은 " +
                                "검증 개수에서 제외됩니다.";
                        }
                    }

                    // 원인 확인용 개발 로그
                    console.info(
                        "ScorePath 검증 집계:",
                        {
                            checked,

                            excludedPreviouslySolved:
                                progress.excludedPreviouslySolved,

                            excludedRepeated:
                                progress.excludedRepeated
                        }
                    );
                }

            } catch (progressError) {

                // 조회 실패가 기존 정답 기록을 취소하면 안 된다.
                console.warn(
                    "검증 진행 개수 갱신 실패:",
                    progressError
                );
            }
        }

        // =====================================
        // 기존 채점 완료
        // =====================================

        return true;

    } catch (error) {

        showMessage(
            error.message ||
            "정답 확인에 실패했습니다.",
            "red"
        );

        return false;

    }
}

async function deleteSolvedNote(id) {
    const ok = confirm(
        "이 복습완료 문제를 삭제할까요?\n삭제한 문제는 휴지통에서 복구할 수 있습니다."
    );

    if (!ok) return;

    try {
        const data = await api(
            "/api/solved/delete",
            "POST",
            { id }
        );

        renderDashboard(data.dashboard);
        showMessage(data.message, "blue");

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
    const ok = confirm(
        "오답 리스트의 모든 문제를 휴지통으로 이동할까요?"
    );

    if (!ok) return;

    try {
        const data = await api(
            "/api/notes/clear",
            "POST"
        );

        renderDashboard(data.dashboard);
        showMessage(data.message, "blue");

    } catch (error) {
        showMessage(error.message, "red");
    }
}

async function clearAllSolvedNotes() {
    const ok = confirm("복습완료 기록을 모두 삭제할까요?");
    if (!ok) return;

    try {
        const data = await api("/api/solved/clear", "POST");
        renderDashboard(data.dashboard);
        showMessage(data.message, "blue");
    } catch (error) {
        showMessage(error.message, "red");
    }
}

async function restoreTrashNote(id) {
    try {
        const data = await api(
            "/api/trash/restore",
            "POST",
            { id }
        );

        renderDashboard(data.dashboard);
        showMessage(data.message, "green");

    } catch (error) {
        showMessage(error.message, "red");
    }
}

async function permanentlyDeleteTrashNote(id) {
    const ok = confirm(
        "이 문제를 영구삭제할까요?\n삭제 후에는 복구할 수 없습니다."
    );

    if (!ok) return;

    try {
        const data = await api(
            "/api/trash/delete",
            "POST",
            { id }
        );

        renderDashboard(data.dashboard);
        showMessage(data.message, "blue");

    } catch (error) {
        showMessage(error.message, "red");
    }
}

async function clearTrash() {
    const notes = dashboardState?.trashNotes || [];

    if (notes.length === 0) {
        showMessage("휴지통이 이미 비어 있습니다.", "blue");
        return;
    }

    const ok = confirm(
        "휴지통의 모든 문제를 영구삭제할까요?\n이 작업은 되돌릴 수 없습니다."
    );

    if (!ok) return;

    try {
        const data = await api(
            "/api/trash/clear",
            "POST"
        );

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

async function retryWrongNote(id) {
    const note =
        (dashboardState?.wrongNotes || [])
            .find(
                (item) =>
                    item.id === id
            );

    if (!note) return;

    try {
        $("subject").value =
            note.subject;

        $("problem").value =
            note.problem || "";

        $("userAnswer").value =
            note.userAnswer;

        $("correctAnswer").value =
            note.correctAnswer;

        if (note.problemImageKey) {
            await loadStoredProblemImage(
                note.problemImageKey
            );
        } else {
            if (
                selectedProblemImage
                    ?.previewUrl
            ) {
                URL.revokeObjectURL(
                    selectedProblemImage
                        .previewUrl
                );
            }

            selectedProblemImage =
                null;

            selectedProblemImageKey =
                "";

            renderSelectedProblemImage();
        }

        currentAnalysisState = {
            aiAnswer:
                note.aiAnswer || "",

            verification:
                note.verification ||
                "uncertain",

            warning:
                note.warning || "",

            reason:
                note.reason,

            concept:
                note.concept,

            solution:
                note.solution,

            similarProblems:
                note.similarProblems ||
                [],

            advancedProblem:
                note.advancedProblem ||
                "아직 응용문제가 없습니다."
        };

        if (
            note.sourceType ===
                "similar" ||
            note.sourceType ===
                "advanced"
        ) {
            activeModeState = {
                type:
                    note.sourceType
            };
        } else {
            activeModeState = null;
        }

        applyPlanToCurrentAnalysis();
        renderCurrentAnalysis();
        updateModeUI();

        const rule =
            getCurrentPlanRule();

        showMessage(
            "오답을 다시 불러왔습니다. 답을 입력하고 정답 확인을 눌러주세요.",
            "blue"
        );

        // =====================================
        // ScorePath 21-138
        // 오답 다시 풀기 → 학습 화면
        // =====================================

        // 이전에 입력했던 내 답은 비운다.
        $("userAnswer").value = "";

        // 4화면 구조에서는 학습 화면을 먼저 표시
        setScorePathMainNavigationV01(
            "study"
        );

        // 화면이 표시된 다음 입력창으로 이동
        requestAnimationFrame(() => {

            $("problem")?.scrollIntoView({
                behavior: "smooth",
                block: "center"
            });

            $("userAnswer")?.focus({
                preventScroll: true
            });

        });

    } catch (error) {
        console.error(
            "오답 다시풀기 불러오기 실패:",
            error
        );

        showMessage(
            error.message ||
                "오답을 불러오지 못했습니다.",
            "red"
        );
    }
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

function toggleTrashSection() {
    const next =
        !getSectionState(
            "trashSectionCollapsed",
            false
        );

    setSectionState(
        "trashSectionCollapsed",
        next
    );

    updateSectionToggle(
        "trashSectionBody",
        "toggleTrashBtn",
        next
    );
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
    updateSectionToggle(
    "trashSectionBody",
    "toggleTrashBtn",
    getSectionState(
        "trashSectionCollapsed",
        false
    )
);
}

document.addEventListener("DOMContentLoaded", () => {
    $("showLoginTab").addEventListener("click", showLoginTab);
    $("showRegisterTab").addEventListener("click", showRegisterTab);
    $("registerBtn").addEventListener("click", register);
    $("loginBtn").addEventListener("click", login);
    $("logoutBtn").addEventListener("click", logout);

    $("addSubjectBtn").addEventListener("click", addSubject);
$("deleteSubjectBtn").addEventListener("click", deleteSubject);

    // =====================================
    // ScorePath 21-258
    // 정답 확인 중복 요청 방지
    // =====================================

      // =====================================
    // ScorePath
    // 정답 확인 중복 제출 방지
    // =====================================

    let scorePathAnswerCheckPending = false;

    let scorePathLastCheckedSignature = "";

    $("checkBtn").addEventListener("click", async () => {

        // 현재 입력 정보로 제출 식별
        const signature = JSON.stringify([

            $("subject")?.value || "",

            $("scorePathExam")?.value || "",

            $("scorePathUnit")?.value || "",

            $("problem")?.value.trim() || "",

               selectedProblemImage?.previewUrl ||
            selectedProblemImageKey ||
            "",

            $("userAnswer")?.value.trim() || "",

            $("correctAnswer")?.value.trim() || "",

            activeModeState?.type || "normal",

            activeModeState?.generatedProblemId || ""

        ]);

        // 요청이 진행 중이면 차단
        if (scorePathAnswerCheckPending) {
            return;
        }

        // 이미 성공적으로 제출한 동일 답안 차단
        if (
            signature ===
            scorePathLastCheckedSignature
        ) {

            showMessage(
                "이미 확인한 답입니다. 답을 수정하거나 다른 문제를 풀어주세요.",
                "blue"
            );

            return;
        }

        scorePathAnswerCheckPending = true;

        const button = $("checkBtn");

        button.disabled = true;

        try {

            const saved = await checkAnswer();

            // 정상 처리된 경우에만 기록
            if (saved === true) {

                scorePathLastCheckedSignature =
                    signature;

            }

        } catch (error) {

            console.error(
                "정답 확인 오류:",
                error
            );

        } finally {

            scorePathAnswerCheckPending = false;

            button.disabled = false;

        }

    });

    // =====================================
    // ScorePath 21-86
    // 기존 문제은행 버튼
    // =====================================

      // =====================================
    // ScorePath UI 간소화
    // 문제 데이터베이스를 기록 화면으로 이동
    // =====================================

       // 데이터베이스는 내부 저장용으로만 사용합니다.
    // 사용자에게는 노트 화면만 표시합니다.

    $("analyzeBtn").addEventListener("click", analyze);
    $("generateAdvancedBtn").addEventListener("click", generateAdvancedProblem);


    // =====================================
// 문제 사진 이벤트
// =====================================

$("selectProblemImageBtn").addEventListener(
    "click",
    () => {
        $("problemImageInput").click();
    }
);


$("changeProblemImageBtn").addEventListener(
    "click",
    () => {
        $("problemImageInput").click();
    }
);


$("removeProblemImageBtn").addEventListener(
    "click",
    removeSelectedProblemImage
);


$("problemImageInput").addEventListener(
    "change",
    () => {
        const file =
            $("problemImageInput")
                .files?.[0];

        if (file) {
            openProblemImageCrop(file);
        }
    }
);


$("cancelImageCropBtn").addEventListener(
    "click",
    cancelProblemImageCrop
);


$("confirmImageCropBtn").addEventListener(
    "click",
    confirmProblemImageCrop
);


// =====================================
// 마우스 Crop
// =====================================

$("imageCropStage").addEventListener(
    "mousedown",
    startImageCrop
);

window.addEventListener(
    "mousemove",
    moveImageCrop
);

window.addEventListener(
    "mouseup",
    endImageCrop
);


// =====================================
// 모바일 터치 Crop
// =====================================

$("imageCropStage").addEventListener(
    "touchstart",
    startImageCrop,
    {
        passive: false
    }
);

window.addEventListener(
    "touchmove",
    moveImageCrop,
    {
        passive: false
    }
);

window.addEventListener(
    "touchend",
    endImageCrop,
    {
        passive: false
    }
);

    $("useAdvancedProblemBtn").addEventListener("click", () => {
        const advanced = currentAnalysisState?.advancedProblem;
        if (!advanced || advanced === "아직 응용문제가 없습니다.") {
            showMessage("먼저 응용문제를 생성하세요.", "red");
            return;
        }

        $("problem").value = advanced;
$("userAnswer").value = "";
$("correctAnswer").value = "";

activeModeState = {
    type: "advanced"
};

// 이전 문제의 분석 결과 제거
currentAnalysisState = null;

renderCurrentAnalysis();
updateModeUI();

showMessage(
    "응용문제를 불러왔습니다. 정답을 직접 입력하고 채점하세요.",
    "blue"
);
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

    // 구형 5,900원 버튼은 숨긴다. (기존 index.html ID 호환)
    const oldPaidButton = $("plan5900");
    if (oldPaidButton) {
        // 구형 버튼과 그 요금제 카드만 숨긴다. 전체 요금제 화면은 숨기지 않는다.
        let current = oldPaidButton;
        let oldCard = oldPaidButton;
        for (let depth = 0; depth < 5 && current.parentElement; depth++) {
            const parent = current.parentElement;
            const planButtons = parent.querySelectorAll(
                "#planFree, #plan5900, #plan8900"
            );
            if (planButtons.length !== 1) break;
            if (/5,?900원|5900원/.test(parent.textContent)) oldCard = parent;
            current = parent;
        }
        oldCard.hidden = true;
        oldCard.style.display = "none";
    }

    const paidButton = $("plan8900");
    if (paidButton) {
        paidButton.textContent = "유료 월 9,900원 (개발 테스트)";
        const paidCard = paidButton.closest(".plan-card, .pricing-card");
        if (paidCard) {
            paidCard.querySelectorAll("*").forEach((node) => {
                if (node.children.length === 0 && /8,?900원/.test(node.textContent)) {
                    node.textContent = node.textContent.replace(/8,?900원/g, "9,900원");
                }
            });
        }
        paidButton.addEventListener("click", () => changePlan("premium9900"));
    }
    $("resetUsageBtn").addEventListener("click", resetUsage);
    $("clearAllBtn").addEventListener("click", clearAllWrongNotes);
    $("clearAllSolvedBtn").addEventListener("click", clearAllSolvedNotes);
$("clearTrashBtn").addEventListener(
    "click",
    clearTrash
);

    // =====================================
    // ScorePath 21-345
    // 오답과 맞힌 문제 검색 동시 갱신
    // =====================================

    const refreshSavedNotesSearchV01 = () => {

        renderWrongList();

        renderSolvedList();

        updateCounts();
    };

    $("filterSubject").addEventListener(
        "change",
        refreshSavedNotesSearchV01
    );

    $("searchInput").addEventListener(
        "input",
        refreshSavedNotesSearchV01
    );

    $("sortType").addEventListener(
        "change",
        refreshSavedNotesSearchV01
    );

    // 맞힌 문제 검색과 통계는 오답 검색과 독립적으로 갱신한다.
    const refreshSolvedNotesSearchV01 = () => {
        renderSolvedList();
        updateCounts();
    };
    $("solvedFilterSubject")?.addEventListener(
        "change", refreshSolvedNotesSearchV01
    );
    $("solvedSearchInput")?.addEventListener(
        "input", refreshSolvedNotesSearchV01
    );
    $("solvedSortType")?.addEventListener(
        "change", refreshSolvedNotesSearchV01
    );

    $("toggleWrongBtn").addEventListener("click", toggleWrongSection);
    $("toggleSolvedBtn").addEventListener("click", toggleSolvedSection);
$("toggleTrashBtn").addEventListener(
    "click",
    toggleTrashSection
);

    // =====================================
    // 기존 화면 상태 복원
    // =====================================

    applySectionStates();

    // 기존 HTML이 <details>일 때도 AI 분석 버튼을 접지 않고 보여준다.
    const studyTools = document.querySelector(".scorepath-study-tools");
    if (studyTools) {
        if (studyTools.tagName.toLowerCase() === "details") studyTools.open = true;
        studyTools.style.border = "2px solid #60a5fa";
        studyTools.style.borderRadius = "14px";
        studyTools.style.background = "#eff6ff";
        studyTools.style.padding = "14px";
    }
    // 오래된 8,900원 / 5회 안내가 남아 있을 때만 최신 요금제로 표시.
    const advancedCaption = $("cardAdvanced")?.querySelector(".check-text");
    if (advancedCaption && /8,?900원|하루\s*5회/.test(advancedCaption.textContent)) {
        advancedCaption.textContent = "월 9,900원 유료 · 응용문제 하루 최대 2회";
    }
    loadMe();


    // =====================================
    // ScorePath V1
    // 날짜 변경 자동 확인
    // =====================================

    // 1분마다 날짜 확인
    // 날짜가 같으면 서버 요청하지 않음

    setInterval(() => {

        void refreshScorePathDailyBoardV01();

    }, 60 * 1000);


    // =====================================
    // 다른 앱에서 돌아왔을 때 확인
    // =====================================

    document.addEventListener(
        "visibilitychange",
        () => {

            if (!document.hidden) {

                void refreshScorePathDailyBoardV01();
            }
        }
    );


    // =====================================
    // 브라우저 창 활성화 시 확인
    // =====================================

    window.addEventListener(
        "focus",
        () => {

            void refreshScorePathDailyBoardV01();
        }
    );


    // =====================================
    // 홈으로 이동했을 때 확인
    // =====================================

    const scorePathBoardObserverV01 =
        new MutationObserver(() => {

            if (
                document.documentElement.dataset
                    .scorepathMainTab === "home"
            ) {

                void refreshScorePathDailyBoardV01();
            }
        });

    scorePathBoardObserverV01.observe(
        document.documentElement,
        {
            attributes: true,

            attributeFilter: [
                "data-scorepath-main-tab"
            ]
        }
    );

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
