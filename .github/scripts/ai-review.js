// @ts-check
const Anthropic = require('@anthropic-ai/sdk');

// ── 환경변수 ────────────────────────────────────────────────────────────────
const GITHUB_TOKEN          = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY     = process.env.ANTHROPIC_API_KEY;
const CONFLUENCE_BASE_URL   = process.env.CONFLUENCE_BASE_URL;
const CONFLUENCE_EMAIL      = process.env.CONFLUENCE_EMAIL;
const CONFLUENCE_TOKEN      = process.env.CONFLUENCE_TOKEN;
const CONFLUENCE_PAGE_ID    = process.env.CONFLUENCE_PAGE_ID;
const HEAD_SHA              = process.env.HEAD_SHA;
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
// ── 1. Confluence 컨벤션 문서 가져오기 ──────────────────────────────────────
async function fetchConventionDoc() {
    if (!CONFLUENCE_BASE_URL || !CONFLUENCE_TOKEN || !CONFLUENCE_PAGE_ID) {
        console.warn('⚠️  Confluence 환경변수가 설정되지 않았습니다.');
        return null;
    }

    const url = `${CONFLUENCE_BASE_URL}/wiki/rest/api/content/${CONFLUENCE_PAGE_ID}?expand=body.storage`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Basic ${Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_TOKEN}`).toString('base64')}`,
            Accept: 'application/json',
        },
    });

    if (!res.ok) throw new Error(`Confluence API 오류: ${res.status} ${res.statusText}`);

    const data = await res.json();
    const html = data.body?.storage?.value ?? '';
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ── 2. 저장소 전체 파일 트리 가져오기 (패키지 구조 체크용) ───────────────────
async function fetchRepoTree() {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${HEAD_SHA}?recursive=1`;
    const res = await fetch(url, { headers: GITHUB_HEADERS });

    if (!res.ok) {
        console.warn(`⚠️  파일 트리 로드 실패: ${res.status}`);
        return null;
    }

    const data = await res.json();
    const paths = data.tree
        .filter(f => f.type === 'blob' && TARGET_EXTENSIONS.test(f.path))
        .map(f => f.path)
        .join('\n');

    return paths || null;
}

// ── 3. PR diff 가져오기 ──────────────────────────────────────────────────────
async function fetchPRFiles() {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${PR_NUMBER}/files`;
    const res = await fetch(url, { headers: GITHUB_HEADERS });

    if (!res.ok) throw new Error(`GitHub API 오류: ${res.status} ${res.statusText}`);

    const files = await res.json();
    const targets = files
        .filter(f => TARGET_EXTENSIONS.test(f.filename) && f.status !== 'removed')
        .slice(0, MAX_FILES);

    // 파일 전체 내용도 함께 가져오기
    const result = await Promise.all(
        targets.map(async f => {
            const contentUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${f.filename}?ref=${HEAD_SHA}`;
            const contentRes = await fetch(contentUrl, { headers: GITHUB_HEADERS });
            const contentData = await contentRes.json();
            const fullContent = Buffer.from(contentData.content, 'base64').toString('utf-8');

            return {
                filename: f.filename,
                status: f.status,
                patch: (f.patch ?? '').slice(0, MAX_PATCH_LENGTH),
                fullContent: fullContent.slice(0, 8000), // 전체 파일 내용
            };
        })
    );

    return result.filter(f => f.patch.length > 0);
}

// ── 4. Claude로 리뷰 생성 ───────────────────────────────────────────────────
async function generateReview(conventionDoc, diffFiles, repoTree) {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const conventionSection = conventionDoc
        ? `## 팀 컨벤션 문서\n${conventionDoc.slice(0, 8000)}`
        : `## 팀 컨벤션 문서\n(문서 없음 - Google Java Style Guide 및 Kotlin Coding Conventions 기준 적용)`;

    const treeSection = repoTree
        ? `## 저장소 전체 패키지 구조\n\`\`\`\n${repoTree}\n\`\`\``
        : '';

    const diffSection = diffFiles
        .map(f => `### [${f.status.toUpperCase()}] ${f.filename}

**변경된 부분 (diff):**
\`\`\`diff
${f.patch}
\`\`\`

**파일 전체 코드:**
\`\`\`kotlin
${f.fullContent}
\`\`\``)
        .join('\n\n');

    const prompt = `당신은 10년 이상 경력의 Java/Kotlin 백엔드 시니어 개발자입니다.
아래 컨벤션 문서, 패키지 구조, PR diff를 분석하여 실용적이고 구체적인 코드 리뷰를 작성하세요.

${conventionSection}

${treeSection}

## PR Diff
${diffSection}

## 리뷰 기준

### 패키지 구조 체크 (컨벤션 문서의 폴더 구조 기준)
- 파일이 올바른 레이어에 위치하는지 (api, core, infrastructure, mapper, configuration)
- 패키지명이 모두 소문자인지
- Service 구현체는 core/{도메인}/service/ 하위에 있는지
- Controller는 api/{도메인}/controller/ 하위에 있는지
- Entity는 infrastructure/coredb/{도메인}/entity/ 하위에 있는지
- Repository는 infrastructure/coredb/{도메인}/repository/ 하위에 있는지

### 컨벤션 체크
- 네이밍: 클래스(Pascal), 메서드/변수(Camel), 상수(Upper Snake), 패키지(lowercase)
- 메서드명은 반드시 동사로 시작
- 변수명은 반드시 명사로 작성
- Controller 레이어 제외 모든 함수에 return type 명시
- Entity에 @Table 어노테이션 사용 금지, @Entity만 사용
- 함수 인자 최대 5개, 초과 시 DTO/VO로 묶기
- 함수 인자 2개 이상이면 줄바꿈 적용
- Service는 인터페이스 + Impl 구조로 작성

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
3. 파일 전체 코드를 기준으로 모든 이슈를 한 번에 파악하세요.
4. diff에서 '+' 로 시작하는 라인(새로 추가된 코드)에 집중하세요.
5. line_content는 diff에서 해당 라인의 실제 코드 내용('+' 제외한 내용)을 그대로 적으세요.
6. 패키지 구조 위반은 파일 경로 기준으로 판단하세요.

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
      "line_content": "문제가 되는 라인의 실제 코드 (공백 포함 정확히, 패키지 구조 이슈는 첫 번째 라인)",
      "severity": "CRITICAL | WARNING | SUGGESTION",
      "category": "CONVENTION | PACKAGE_STRUCTURE | CODE_QUALITY | PERFORMANCE | SECURITY | READABILITY",
      "message": "한국어로 구체적인 리뷰 내용",
      "suggestion": "개선된 코드 또는 올바른 파일 경로 예시 (없으면 null)"
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

// ── 5. 이전 봇 코멘트 삭제 (PR 재푸시 시 중복 방지) ────────────────────────
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

// ── 6. 요약 코멘트 등록 ─────────────────────────────────────────────────────
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

// ── 7. 인라인 리뷰 코멘트 등록 ─────────────────────────────────────────────
async function postInlineComments(reviewData, diffFiles) {
    const SEVERITY_EMOJI = { CRITICAL: '🔴', WARNING: '🟡', SUGGESTION: '🟢' };
    const CATEGORY_LABEL = {
        CONVENTION:        '컨벤션',
        PACKAGE_STRUCTURE: '패키지 구조',
        CODE_QUALITY:      '코드 품질',
        PERFORMANCE:       '성능',
        SECURITY:          '보안',
        READABILITY:       '가독성',
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

    console.log('🌳 저장소 패키지 구조 로딩...');
    const repoTree = await fetchRepoTree();
    if (repoTree) console.log(`   ✅ 파일 트리 로드 완료`);

    console.log('📂 PR diff 로딩...');
    const diffFiles = await fetchPRFiles();
    console.log(`   ✅ 대상 파일: ${diffFiles.map(f => f.filename).join(', ') || '없음'}`);

    if (diffFiles.length === 0) {
        console.log('리뷰할 Java/Kotlin 파일이 없습니다. 종료합니다.');
        return;
    }

    console.log('\n🤖 Claude로 리뷰 생성 중...');
    const reviewData = await generateReview(conventionDoc, diffFiles, repoTree);
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