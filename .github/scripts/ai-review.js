// @ts-check
const Anthropic = require('@anthropic-ai/sdk');

// ── 환경변수 ────────────────────────────────────────────────────────────────
const GITHUB_TOKEN       = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const CONFLUENCE_BASE_URL = process.env.CONFLUENCE_BASE_URL;
const CONFLUENCE_TOKEN   = process.env.CONFLUENCE_TOKEN;
const CONFLUENCE_PAGE_ID = process.env.CONFLUENCE_PAGE_ID;
const HEAD_SHA           = process.env.HEAD_SHA;
const [owner, repo]      = (process.env.REPO ?? '').split('/');
const PR_NUMBER          = parseInt(process.env.PR_NUMBER ?? '0', 10);

const GITHUB_HEADERS = {
    Authorization:  `Bearer ${GITHUB_TOKEN}`,
    Accept:         'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
};

// 리뷰 대상 확장자
const TARGET_EXTENSIONS = /\.(java|kt|kts)$/;
// 파일당 최대 diff 길이 (토큰 절약)
const MAX_PATCH_LENGTH = 5000;
// 파일 최대 처리 개수
const MAX_FILES = 15;

// ── 1. Confluence 컨벤션 문서 가져오기 ──────────────────────────────────────
async function fetchConventionDoc() {
    const CONVENTION_URL = 'https://deliveredkorea.atlassian.net/wiki/external/MDQ5MzM4NDY2MzFmNDc4MWFjNjkxZmQwNmFlODg4NTA';

    const res = await fetch(CONVENTION_URL);
    const html = await res.text();

    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ── 2. PR diff 가져오기 ──────────────────────────────────────────────────────
async function fetchPRFiles() {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${PR_NUMBER}/files`;
    const res = await fetch(url, { headers: GITHUB_HEADERS });

    if (!res.ok) {
        throw new Error(`GitHub API 오류: ${res.status} ${res.statusText}`);
    }

    const files = await res.json();

    return files
        .filter(f => TARGET_EXTENSIONS.test(f.filename) && f.status !== 'removed')
        .slice(0, MAX_FILES)
        .map(f => ({
            filename: f.filename,
            status: f.status, // added | modified
            patch: (f.patch ?? '').slice(0, MAX_PATCH_LENGTH),
        }))
        .filter(f => f.patch.length > 0);
}

// ── 3. Claude로 리뷰 생성 ───────────────────────────────────────────────────
async function generateReview(conventionDoc, diffFiles) {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const conventionSection = conventionDoc
        ? `## 팀 컨벤션 문서\n${conventionDoc.slice(0, 8000)}`
        : `## 팀 컨벤션 문서\n(문서 없음 - Google Java Style Guide 및 Kotlin Coding Conventions 기준 적용)`;

    const diffSection = diffFiles
        .map(f => `### [${f.status.toUpperCase()}] ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``)
        .join('\n\n');

    const prompt = `당신은 10년 이상 경력의 Java/Kotlin 백엔드 시니어 개발자입니다.
아래 컨벤션 문서와 PR diff를 분석하여 실용적이고 구체적인 코드 리뷰를 작성하세요.

${conventionSection}

## PR Diff
${diffSection}

## 리뷰 기준
### 컨벤션 체크
- 컨벤션 문서에 명시된 규칙 위반
- 네이밍 컨벤션 (클래스, 메서드, 변수, 상수)
- 패키지 구조 및 파일 구성 규칙

### 코드 품질 체크
- Null safety / 잠재적 NPE
- 예외 처리 방식 (catch-all, 빈 catch 블록 등)
- 불필요한 복잡도 / 중복 코드
- Kotlin idiom 활용 여부 (scope functions, data class, sealed class 등)
- Spring/JPA 안티패턴 (N+1, 트랜잭션 누락 등)

### 성능 / 보안
- 불필요한 DB 쿼리, 반복 호출
- SQL Injection, 민감정보 노출 위험

## 응답 규칙
1. 실제로 문제가 있는 코드만 지적하세요. 억지 지적 금지.
2. 개선 제안 코드는 반드시 실제로 동작 가능한 코드여야 합니다.
3. diff에서 '+' 로 시작하는 라인(새로 추가된 코드)에 집중하세요.
4. line_content는 diff에서 해당 라인의 실제 코드 내용('+' 제외한 내용)을 그대로 적으세요.

반드시 아래 JSON 형식으로만 응답하세요. JSON 외 다른 텍스트는 절대 포함하지 마세요:
{
  "summary": "전체 리뷰 요약 (3줄 이내, 긍정적인 부분도 포함)",
  "stats": {
    "critical": 0,
    "warning": 0,
    "suggestion": 0
  },
  "comments": [
    {
      "filename": "경로 포함한 파일명",
      "line_content": "문제가 되는 라인의 실제 코드 (공백 포함 정확히)",
      "severity": "CRITICAL | WARNING | SUGGESTION",
      "category": "CONVENTION | CODE_QUALITY | PERFORMANCE | SECURITY | READABILITY",
      "message": "한국어로 구체적인 리뷰 내용",
      "suggestion": "개선된 코드 예시 (없으면 null)"
    }
  ]
}`;

    const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

    // JSON 파싱 (마크다운 펜스 제거 후)
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude 응답에서 JSON을 파싱할 수 없습니다:\n' + text);

    return JSON.parse(jsonMatch[0]);
}

// ── 4. 이전 봇 코멘트 삭제 (PR 재푸시 시 중복 방지) ────────────────────────
async function deletePreviousBotComments() {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`;
    const res = await fetch(url, { headers: GITHUB_HEADERS });
    const comments = await res.json();

    const botComments = (Array.isArray(comments) ? comments : []).filter(
        c => c.user?.type === 'Bot' && c.body?.includes('<!-- ai-code-review -->')
    );

    await Promise.all(
        botComments.map(c =>
            fetch(`https://api.github.com/repos/${owner}/${repo}/issues/comments/${c.id}`, {
                method: 'DELETE',
                headers: GITHUB_HEADERS,
            })
        )
    );

    console.log(`🧹 이전 봇 코멘트 ${botComments.length}개 삭제`);
}

// ── 5. 요약 코멘트 등록 ─────────────────────────────────────────────────────
async function postSummaryComment(reviewData) {
    const { summary, stats } = reviewData;

    const body = `<!-- ai-code-review -->
## 🤖 AI Code Review 결과

${summary}

| 구분 | 건수 |
|------|------|
| 🔴 CRITICAL | ${stats?.critical ?? 0} |
| 🟡 WARNING  | ${stats?.warning ?? 0} |
| 🟢 SUGGESTION | ${stats?.suggestion ?? 0} |

> *Powered by Claude Sonnet — 컨벤션 문서 기반 자동 리뷰*`;

    const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`,
        {
            method: 'POST',
            headers: GITHUB_HEADERS,
            body: JSON.stringify({ body }),
        }
    );

    if (!res.ok) {
        console.error('요약 코멘트 등록 실패:', await res.text());
    }
}

// ── 6. 인라인 리뷰 코멘트 등록 ─────────────────────────────────────────────
async function postInlineComments(reviewData, diffFiles) {
    const SEVERITY_EMOJI = { CRITICAL: '🔴', WARNING: '🟡', SUGGESTION: '🟢' };
    const CATEGORY_LABEL = {
        CONVENTION:    '컨벤션',
        CODE_QUALITY:  '코드 품질',
        PERFORMANCE:   '성능',
        SECURITY:      '보안',
        READABILITY:   '가독성',
    };

    let successCount = 0;
    let failCount = 0;

    for (const comment of reviewData.comments) {
        const file = diffFiles.find(f => f.filename === comment.filename);
        if (!file) {
            console.warn(`파일을 찾을 수 없음: ${comment.filename}`);
            continue;
        }

        const position = findPositionInDiff(file.patch, comment.line_content);
        if (position === -1) {
            console.warn(`라인 위치를 찾을 수 없음: "${comment.line_content}" in ${comment.filename}`);
            failCount++;
            continue;
        }

        const emoji    = SEVERITY_EMOJI[comment.severity] ?? '🟢';
        const category = CATEGORY_LABEL[comment.category] ?? comment.category;

        let body = `${emoji} **[${category}]** ${comment.message}`;
        if (comment.suggestion) {
            const lang = comment.filename.endsWith('.kt') ? 'kotlin' : 'java';
            body += `\n\n**💡 개선 제안:**\n\`\`\`${lang}\n${comment.suggestion}\n\`\`\``;
        }

        const res = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${PR_NUMBER}/comments`,
            {
                method: 'POST',
                headers: GITHUB_HEADERS,
                body: JSON.stringify({
                    body,
                    commit_id: HEAD_SHA,
                    path: comment.filename,
                    position,
                }),
            }
        );

        if (res.ok) {
            successCount++;
        } else {
            const err = await res.text();
            console.warn(`인라인 코멘트 등록 실패 (${comment.filename}:${position}): ${err}`);
            failCount++;
        }
    }

    console.log(`💬 인라인 코멘트: 성공 ${successCount}개 / 실패 ${failCount}개`);
}

// diff patch 문자열에서 특정 코드 라인의 position 찾기
// GitHub Pull Request Review Comment API는 diff 내 1-based position을 사용함
function findPositionInDiff(patch, lineContent) {
    if (!patch || !lineContent) return -1;

    const needle = lineContent.trim();
    const lines  = patch.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const raw  = lines[i];
        // '+' 로 시작하는 추가 라인 또는 공백(context)으로 시작하는 라인만 대상
        if (!raw.startsWith('+') && !raw.startsWith(' ')) continue;

        const code = raw.slice(1).trim(); // '+' 또는 ' ' 제거
        if (code === needle || code.includes(needle)) {
            return i + 1; // 1-based position
        }
    }
    return -1;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n🚀 AI Code Review 시작 — PR #${PR_NUMBER} (${owner}/${repo})\n`);

    console.log('📄 Confluence 컨벤션 문서 로딩...');
    const conventionDoc = await fetchConventionDoc();
    if (conventionDoc) {
        console.log(`   ✅ 컨벤션 문서 로드 완료 (${conventionDoc.length.toLocaleString()} chars)`);
    }

    console.log('📂 PR diff 로딩...');
    const diffFiles = await fetchPRFiles();
    console.log(`   ✅ 대상 파일: ${diffFiles.map(f => f.filename).join(', ') || '없음'}`);

    if (diffFiles.length === 0) {
        console.log('리뷰할 Java/Kotlin 파일이 없습니다. 종료합니다.');
        return;
    }

    console.log('\n🤖 Claude로 리뷰 생성 중...');
    const reviewData = await generateReview(conventionDoc, diffFiles);
    console.log(`   ✅ 코멘트 ${reviewData.comments?.length ?? 0}개 생성`);

    console.log('\n🧹 이전 봇 코멘트 정리...');
    await deletePreviousBotComments();

    console.log('\n📝 리뷰 등록 중...');
    await postSummaryComment(reviewData);
    await postInlineComments(reviewData, diffFiles);

    console.log('\n✅ AI Code Review 완료!\n');
}

main().catch(err => {
    console.error('❌ 오류 발생:', err);
    process.exit(1);
});