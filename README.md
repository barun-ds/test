# 0) 레포와 파일 배치 한눈표

- **`barunntechnicaloffice/barunson-ci-templates`** (이미 있음: 재사용 WF)
    - `.github/workflows/aws-ecr-deploy.yml` ← **이미 있음(중앙 재사용 워크플로우)**
- **`barunntechnicaloffice/infra-apps`**（App-of-Apps 저장소）
    - `root-app/Chart.yaml`　← 새로 생성
    - `root-app/values.yaml`　← 새로 생성（서비스 목록 `apps:[]`）
    - `root-app/templates/application.yaml` ← 새로 생성（서비스별 ArgoCD Application 루프）
    - (클러스터 적용용) `argo-root-app.yaml` ← 로컬에서 만들고 `kubectl apply -f`로 1회 적용
- **`barunntechnicaloffice/scaffold-ops`**（스캐폴딩 허브 저장소）
    - `.github/ISSUE_TEMPLATE/new-service.yml` ← 새서비스 요청 폼
    - `.github/ISSUE_TEMPLATE/adopt-existing.yml` ← 기존 레포 채택 폼
    - `.github/workflows/new-service.yml` ← 새 레포 만들고 파일 주입 + infra-apps PR
    - `.github/workflows/adopt-existing.yml` ← 기존 레포에 CI/Helm PR + infra-apps PR
    - `.github/workflows/repository-dispatch.yml` ← (Bot A가 보내는) repo_dispatch 수신해서 adopt 실행
- **서비스 각 레포**（개발자 코드 저장소）
    - 자동 PR로 추가됨:
        - `.github/workflows/deploy.yml`（재사용 WF 호출）
        - `helm/` 디렉토리(Chart/values/templates)

---

# 1) App-of-Apps 세팅 (한 번만)

## 1-1. `infra-apps` 파일 생성

`root-app/templates/application.yaml`

```yaml
{{- range .Values.apps }}
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: {{ .name }}
  namespace: argocd
spec:
  project: default
  source:
    repoURL: {{ .repoURL }}
    targetRevision: {{ .revision | default "main" }}
    path: {{ .path | default "helm" }}
    helm:
      valueFiles: ["values.yaml"]
  destination:
    server: https://kubernetes.default.svc
    namespace: {{ .namespace | default "app" }}
  syncPolicy:
    automated: { prune: true, selfHeal: true }
---
{{- end }}
```

`root-app/Chart.yaml`

```yaml
apiVersion: v2
name: root-app
version: 0.1.0
```

`root-app/values.yaml` (초기값)

```yaml
apps:
  - name: sample-app
    repoURL: https://github.com/barunntechnicaloffice/sample-app.git
    namespace: app
```

## 1-2. 루트 Application 클러스터에 1회 적용

`argo-root-app.yaml` (로컬 파일)

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root-app
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/barunntechnicaloffice/infra-apps.git
    targetRevision: main
    path: root-app
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated: { prune: true, selfHeal: true }
```

```bash
kubectl apply -f argo-root-app.yaml
```

> 이후부터는 infra-apps/root-app/values.yaml의 apps:에 한 줄 추가 PR만 하면 ArgoCD가 새 Application 생성/동기화합니다.
> 

---

# 2) 스캐폴딩 허브(`scaffold-ops`) 구성

## 2-1. 이슈 폼 (경로 고정)

`.github/ISSUE_TEMPLATE/new-service.yml`

```yaml
name: New Service
title: "[New] "
labels: ["new-service"]
body:
  - type: input
    id: service
    attributes: { label: Service name (kebab-case), placeholder: order-api }
    validations: { required: true }
  - type: input
    id: ecr
    attributes: { label: ECR repository name, placeholder: order-api }
    validations: { required: true }
  - type: input
    id: role
    attributes: { label: OIDC Role ARN, placeholder: arn:aws:iam::768157413559:role/github-oidc-768157413559-ap-northeast-2-shared-role }
    validations: { required: true }
  - type: input
    id: port
    attributes: { label: Service port, placeholder: "3000" }
    validations: { required: false }
  - type: input
    id: ns
    attributes: { label: Kubernetes namespace, placeholder: "app" }
    validations: { required: false }
```

`.github/ISSUE_TEMPLATE/adopt-existing.yml`

```yaml
name: Adopt Existing Repo
title: "[Adopt] "
labels: ["adopt-existing"]
body:
  - type: input
    id: repo
    attributes: { label: Target repo (owner/name), placeholder: barunntechnicaloffice/existing-svc }
    validations: { required: true }
  - type: input
    id: ecr
    attributes: { label: ECR repository name, placeholder: existing-svc }
    validations: { required: true }
  - type: input
    id: role
    attributes: { label: OIDC Role ARN, placeholder: arn:aws:iam::768157413559:role/github-oidc-768157413559-ap-northeast-2-shared-role }
    validations: { required: true }
  - type: input
    id: port
    attributes: { label: Service port, placeholder: "3000" }
  - type: input
    id: ns
    attributes: { label: Kubernetes namespace, placeholder: "app" }
```

> 포트/네임스페이스: 기본은 3000 / app으로 두되, 개발자가 폼에 입력해 오버라이드할 수 있게 했어. (질문 3에 대한 답: 네, 개발자 입력으로 받되 기본값 보장!)
> 

## 2-2. 새 서비스 워크플로우

`.github/workflows/new-service.yml`

- 새 레포 생성 → CI/Helm 커밋 → **서비스 레포 deploy.yml은 “재사용 WF 호출”** 형태로 생성 → `infra-apps`에 등록 PR

(핵심 부분만)

```yaml
name: New Service Scaffolding
on:
  issues: { types: [opened] }
permissions: { contents: write, pull-requests: write }
jobs:
  go:
    if: contains(github.event.issue.labels.*.name, 'new-service')
    runs-on: ubuntu-latest
    steps:
      - name: Generate GitHub App Token
        id: app-token
        run: |
          # Create JWT for GitHub App authentication
          HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | base64 | tr -d '\n' | tr '/+' '_-' | tr -d '=')
          
          # JWT payload
          NOW=$(date +%s)
          IAT=$((NOW - 60))
          EXP=$((NOW + 300))
          PAYLOAD=$(echo -n "{\"iat\":$IAT,\"exp\":$EXP,\"iss\":\"${{ secrets.GITHUB_APP_ID }}\"}" | base64 | tr -d '\n' | tr '/+' '_-' | tr -d '=')
          
          # Sign JWT with private key
          UNSIGNED_TOKEN="$HEADER.$PAYLOAD"
          
          # Create private key file
          echo "${{ secrets.GITHUB_APP_PRIVATE_KEY }}" > private_key.pem
          
          # Sign with OpenSSL
          SIGNATURE=$(echo -n "$UNSIGNED_TOKEN" | openssl dgst -sha256 -sign private_key.pem | base64 | tr -d '\n' | tr '/+' '_-' | tr -d '=')
          JWT="$UNSIGNED_TOKEN.$SIGNATURE"
          
          # Clean up private key
          rm private_key.pem
          
          # Get installation access token
          INSTALLATION_TOKEN=$(curl -s -X POST \
            -H "Authorization: Bearer $JWT" \
            -H "Accept: application/vnd.github.v3+json" \
            "https://api.github.com/app/installations/${{ secrets.GITHUB_APP_INSTALLATION_ID }}/access_tokens" | \
            jq -r '.token')
          
          echo "::add-mask::$INSTALLATION_TOKEN"
          echo "token=$INSTALLATION_TOKEN" >> $GITHUB_OUTPUT

      - name: Parse
        id: p
        run: |
          BODY="${{ github.event.issue.body }}"
          get(){ echo "$BODY" | sed -n "s/.*$1.*\n*//p" | head -1 | xargs; }
          echo "SVC=$(get 'Service name')" >> $GITHUB_OUTPUT
          echo "ECR=$(get 'ECR repository name')" >> $GITHUB_OUTPUT
          echo "ROLE=$(get 'OIDC Role ARN')" >> $GITHUB_OUTPUT
          echo "PORT=$(get 'Service port')" >> $GITHUB_OUTPUT
          echo "NS=$(get 'Kubernetes namespace')" >> $GITHUB_OUTPUT

      - name: Create repo from template
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: gh repo create barunntechnicaloffice/${{ steps.p.outputs.SVC }} --private -y --template barunntechnicaloffice/service-template

      - name: Inject deploy.yml & Helm
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          git clone https://github.com/barunntechnicaloffice/${{ steps.p.outputs.SVC }}.git
          cd ${{ steps.p.outputs.SVC }}
          mkdir -p .github/workflows helm/templates

          cat > .github/workflows/deploy.yml <<'YAML'
          name: Deploy (call reusable)
          permissions: { contents: read, id-token: write }
          on: { push: { branches: ["main"] } }
          jobs:
            call-shared:
              uses: barunntechnicaloffice/barunson-ci-templates/.github/workflows/aws-ecr-deploy.yml@main
              with:
                ecr-repository: __ECR__
                aws-region: ap-northeast-2
                role-arn: __ROLE__
          YAML
          sed -i "s|__ECR__|${{ steps.p.outputs.ECR }}|g" .github/workflows/deploy.yml
          sed -i "s|__ROLE__|${{ steps.p.outputs.ROLE }}|g" .github/workflows/deploy.yml

          cat > helm/Chart.yaml <<'EOF'
          apiVersion: v2
          name: app
          version: 0.1.0
          EOF

          PORT=${{ steps.p.outputs.PORT }}; [ -z "$PORT" ] && PORT=3000
          cat > helm/values.yaml <<EOF
          image:
            repository: 768157413559.dkr.ecr.ap-northeast-2.amazonaws.com/${{ steps.p.outputs.ECR }}
            tag: latest
          service:
            port: $PORT
          EOF

          cat > helm/templates/deployment.yaml <<'EOF'
          apiVersion: apps/v1
          kind: Deployment
          metadata: { name: {{ include "app.fullname" . }} }
          spec:
            replicas: 1
            selector: { matchLabels: { app: {{ include "app.name" . }} } }
            template:
              metadata: { labels: { app: {{ include "app.name" . }} } }
              spec:
                containers:
                - name: app
                  image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
                  ports: [{ containerPort: {{ .Values.service.port }} }]
          EOF

          git config user.email "bot@barun"; git config user.name "scaffold-bot"
          git add . && git commit -m "chore: scaffold initial" && git push

      - name: Register to infra-apps (App-of-Apps)
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          NS=${{ steps.p.outputs.NS }}; [ -z "$NS" ] && NS=app
          git clone https://github.com/barunntechnicaloffice/infra-apps.git
          cd infra-apps/root-app
          git checkout -b feat/${{ steps.p.outputs.SVC }}-register
          yq -i '.apps += [{"name":"'"${{ steps.p.outputs.SVC }}"'","repoURL":"https://github.com/barunntechnicaloffice/'"${{ steps.p.outputs.SVC }}"'.git","namespace":"'"$NS"'"}]' values.yaml
          git add values.yaml && git commit -m "feat: register ${{ steps.p.outputs.SVC }}"
          git push origin HEAD
          gh pr create -R barunntechnicaloffice/infra-apps -t "Register ${{ steps.p.outputs.SVC }}" -b "Auto by scaffold"
```

## 2-3. 기존 레포 채택 워크플로우

`.github/workflows/adopt-existing.yml`

- 대상 레포에 **deploy.yml/helm**이 없으면 자동 PR로 추가
- `infra-apps` 등록 PR도 함께 생성

(핵심만)

```yaml
name: Adopt Existing
on:
  issues: { types: [opened] }
permissions: { contents: write, pull-requests: write }
jobs:
  go:
    if: contains(github.event.issue.labels.*.name, 'adopt-existing')
    runs-on: ubuntu-latest
    env:
      GITHUB_TOKEN: ${{ steps.github-app-token.outputs.token }}
    steps:
      - name: Parse
        id: p
        run: |
          BODY="${{ github.event.issue.body }}"
          get(){ echo "$BODY" | sed -n "s/.*$1.*\n*//p" | head -1 | xargs; }
          echo "REPO=$(get 'Target repo')" >> $GITHUB_OUTPUT
          echo "ECR=$(get 'ECR repository name')" >> $GITHUB_OUTPUT
          echo "ROLE=$(get 'OIDC Role ARN')" >> $GITHUB_OUTPUT
          echo "PORT=$(get 'Service port')" >> $GITHUB_OUTPUT
          echo "NS=$(get 'Kubernetes namespace')" >> $GITHUB_OUTPUT

      - name: Patch target repo
        run: |
          gh repo clone ${{ steps.p.outputs.REPO }} target
          cd target
          git checkout -b chore/enable-cicd
          mkdir -p .github/workflows helm/templates

          if [ ! -f .github/workflows/deploy.yml ]; then
            cat > .github/workflows/deploy.yml <<'YAML'
            name: Deploy (call reusable)
            permissions: { contents: read, id-token: write }
            on: { push: { branches: ["main"] } }
            jobs:
              call-shared:
                uses: barunntechnicaloffice/barunson-ci-templates/.github/workflows/aws-ecr-deploy.yml@main
                with:
                  ecr-repository: __ECR__
                  aws-region: ap-northeast-2
                  role-arn: __ROLE__
            YAML
            sed -i "s|__ECR__|${{ steps.p.outputs.ECR }}|g" .github/workflows/deploy.yml
            sed -i "s|__ROLE__|${{ steps.p.outputs.ROLE }}|g" .github/workflows/deploy.yml
          fi

          if [ ! -d helm ]; then
            PORT=${{ steps.p.outputs.PORT }}; [ -z "$PORT" ] && PORT=3000
            cat > helm/Chart.yaml <<'EOF'
            apiVersion: v2
            name: app
            version: 0.1.0
            EOF
            cat > helm/values.yaml <<EOF
            image:
              repository: 768157413559.dkr.ecr.ap-northeast-2.amazonaws.com/${{ steps.p.outputs.ECR }}
              tag: latest
            service:
              port: $PORT
            EOF
            mkdir -p helm/templates
            cat > helm/templates/deployment.yaml <<'EOF'
            apiVersion: apps/v1
            kind: Deployment
            metadata: { name: {{ include "app.fullname" . }} }
            spec:
              replicas: 1
              selector: { matchLabels: { app: {{ include "app.name" . }} } }
              template:
                metadata: { labels: { app: {{ include "app.name" . }} } }
                spec:
                  containers:
                  - name: app
                    image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
                    ports: [{ containerPort: {{ .Values.service.port }} }]
            EOF
          fi

          git config user.email "bot@barun"; git config user.name "scaffold-bot"
          git add . && git commit -m "chore: enable CI/CD & helm" || true
          git push -u origin HEAD
          gh pr create -t "Enable CI/CD & Helm (auto)" -b "Auto-scaffolded by ops bot" || true

      - name: Register to infra-apps
        run: |
          SVC=${{ steps.p.outputs.REPO##*/ }}
          NS=${{ steps.p.outputs.NS }}; [ -z "$NS" ] && NS=app
          git clone https://github.com/barunntechnicaloffice/infra-apps.git
          cd infra-apps/root-app
          git checkout -b feat/${SVC}-register
          yq -i '.apps += [{"name":"'"$SVC"'","repoURL":"https://github.com/'"${{ steps.p.outputs.REPO }}"'.git","namespace":"'"$NS"'"}]' values.yaml
          git add values.yaml && git commit -m "feat: register $SVC"
          git push origin HEAD
          gh pr create -R barunntechnicaloffice/infra-apps -t "Register $SVC" -b "Auto by scaffold"

```

## 2-4. Bot A 연동용 `repository_dispatch` 수신 WF

`.github/workflows/repository-dispatch.yml`

```yaml
name: Dispatch Entry
on:
  repository_dispatch:
    types: [adopt-existing, new-service]
permissions:
  contents: write
  pull-requests: write
jobs:
  adopt:
    if: github.event.action == 'adopt-existing'
    runs-on: ubuntu-latest
    steps:
      - name: Create Issue for Adopt Existing
        uses: actions/github-script@v7
        with:
          script: |
            const payload = context.payload.client_payload;
            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `[Adopt] ${payload.repo}`,
              body: `Target repo (owner/name): ${payload.repo}
            ECR repository name: ${payload.ecr}
            OIDC Role ARN: ${payload.role}
            Service port: ${payload.port || '3000'}
            Kubernetes namespace: ${payload.namespace || 'app'}`,
              labels: ['adopt-existing']
            });
  
  new:
    if: github.event.action == 'new-service'
    runs-on: ubuntu-latest
    steps:
      - name: Create Issue for New Service
        uses: actions/github-script@v7
        with:
          script: |
            const payload = context.payload.client_payload;
            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `[New] ${payload.service}`,
              body: `Service name (kebab-case): ${payload.service}
            ECR repository name: ${payload.ecr}
            OIDC Role ARN: ${payload.role}
            Service port: ${payload.port || '3000'}
            Kubernetes namespace: ${payload.namespace || 'app'}`,
              labels: ['new-service']
            });
```

> Lambda Bot이 repository_dispatch를 보내면, 여기서 client_payload 데이터를 받아서 이슈를 생성합니다. 생성된 이슈가 자동으로 해당 워크플로우를 트리거합니다.
> 

---

# 3) Bot 명령 방법 A — **GitHub App** 방식 (상세)

## 3-1. 깃허브 앱 만들기

- Org → **Settings → Developer settings → GitHub Apps → New GitHub App**
- **Permissions**
    - Repository: **Issues (Read & write)**, **Pull requests (Read & write)**, **Contents (Read & write)**, **Metadata (Read)**
- **Subscribe to events**
    - `issue_comment`
- **Webhook**
    - URL: (아래 앱 서버 주소)
    - Secret: 임의 문자열(앱에서 검증에 사용)
- 앱 생성 후 **Install App** → **Organization 전체** 또는 선택 레포에 설치
- **App ID, Installation ID, Private Key(PEM)** 보관

## 3-2. AWS Lambda로 GitHub Bot 구현 (완전한 솔루션)

### SAM 프로젝트 구조 생성

```bash
mkdir github-bot-lambda
cd github-bot-lambda
sam init --runtime nodejs18.x --name github-bot-lambda --app-template hello-world
```

### template.yaml (AWS SAM 템플릿)

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: GitHub Bot Lambda Function

Globals:
  Function:
    Timeout: 30
    MemorySize: 256
    Runtime: nodejs18.x

Parameters:
  GitHubAppId:
    Type: String
    Description: GitHub App ID
    NoEcho: true
  GitHubWebhookSecret:
    Type: String
    Description: GitHub Webhook Secret
    NoEcho: true
  GitHubAppPrivateKey:
    Type: String
    Description: GitHub App Private Key (base64 encoded)
    NoEcho: true

Resources:
  GitHubBotFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: app.handler
      Environment:
        Variables:
          GITHUB_APP_ID: !Ref GitHubAppId
          GITHUB_WEBHOOK_SECRET: !Ref GitHubWebhookSecret
          GITHUB_APP_PRIVATE_KEY: !Ref GitHubAppPrivateKey
      Events:
        GitHubWebhook:
          Type: Api
          Properties:
            Path: /webhook
            Method: post
      Policies:
        - Version: '2012-10-17'
          Statement:
            - Effect: Allow
              Action:
                - logs:CreateLogGroup
                - logs:CreateLogStream
                - logs:PutLogEvents
              Resource: '*'

Outputs:
  GitHubBotApi:
    Description: "API Gateway endpoint URL for GitHub Bot"
    Value: !Sub "https://${ServerlessRestApi}.execute-api.${AWS::Region}.amazonaws.com/Prod/webhook"
```

### src/app.js (Lambda 함수 코드)

```javascript
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { createAppAuth } = require('@octokit/auth-app');

// GitHub webhook signature 검증
function verifySignature(payload, signature, secret) {
    const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(payload, 'utf8')
        .digest('hex');
    return crypto.timingSafeEqual(
        Buffer.from(signature, 'utf8'),
        Buffer.from(expectedSignature, 'utf8')
    );
}

// GitHub App 인증으로 Octokit 인스턴스 생성
async function createGitHubAppClient(installationId) {
    const octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
            appId: process.env.GITHUB_APP_ID,
            privateKey: Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY, 'base64').toString(),
            installationId: installationId,
        }
    });
    return octokit;
}

// repository_dispatch 이벤트 발송
async function sendRepositoryDispatch(octokit, owner, eventType, payload) {
    try {
        await octokit.repos.createDispatchEvent({
            owner: owner,
            repo: 'scaffold-ops',
            event_type: eventType,
            client_payload: payload
        });
        console.log(`Repository dispatch sent: ${eventType}`);
    } catch (error) {
        console.error('Failed to send repository dispatch:', error.message);
        throw error;
    }
}

exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));

    try {
        const payload = event.body;
        const signature = event.headers['X-Hub-Signature-256'] || event.headers['x-hub-signature-256'];
        const githubEvent = event.headers['X-GitHub-Event'] || event.headers['x-github-event'];

        // Webhook signature 검증
        if (!verifySignature(payload, signature, process.env.GITHUB_WEBHOOK_SECRET)) {
            console.error('Invalid webhook signature');
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Invalid signature' })
            };
        }

        const body = JSON.parse(payload);
        console.log(`GitHub Event: ${githubEvent}, Action: ${body.action}`);

        // issue_comment 이벤트 처리
        if (githubEvent === 'issue_comment' && body.action === 'created') {
            const comment = body.comment.body.trim();
            const owner = body.repository.owner.login;
            const repo = body.repository.name;
            const installationId = body.installation.id;

            console.log(`Comment: "${comment}" in ${owner}/${repo}`);

            if (comment.startsWith('/enable-cicd')) {
                const octokit = await createGitHubAppClient(installationId);
                
                // scaffold-ops에 adopt-existing 이벤트 전송
                await sendRepositoryDispatch(octokit, owner, 'adopt-existing', {
                    repo: `${owner}/${repo}`,
                    ecr: repo,  // ECR 이름 = 레포명 규칙
                    role: 'arn:aws:iam::768157413559:role/github-oidc-768157413559-ap-northeast-2-shared-role',
                    port: '3000',
                    namespace: 'app',
                    trigger_user: body.comment.user.login,
                    issue_number: body.issue.number
                });

                // 댓글에 응답 (선택사항)
                await octokit.issues.createComment({
                    owner: owner,
                    repo: repo,
                    issue_number: body.issue.number,
                    body: `🚀 CI/CD 파이프라인 설정을 시작합니다. [scaffold-ops](https://github.com/${owner}/scaffold-ops/actions)에서 진행상황을 확인하세요.`
                });
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Webhook processed successfully' })
        };

    } catch (error) {
        console.error('Error processing webhook:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};
```

### package.json

```json
{
  "name": "github-bot-lambda",
  "version": "1.0.0",
  "description": "GitHub Bot Lambda Function",
  "main": "app.js",
  "dependencies": {
    "@octokit/rest": "^20.0.2",
    "@octokit/auth-app": "^6.0.1"
  },
  "devDependencies": {
    "jest": "^29.5.0"
  },
  "scripts": {
    "test": "jest"
  }
}
```

### 배포 명령어

```bash
# 의존성 설치 및 빌드
sam build

# 배포 (처음 배포시)
sam deploy --guided --parameter-overrides \
  GitHubAppId=YOUR_APP_ID \
  GitHubWebhookSecret=YOUR_WEBHOOK_SECRET \
  GitHubAppPrivateKey=YOUR_BASE64_ENCODED_PRIVATE_KEY

# 이후 배포시
sam deploy
```

### GitHub App 설정

1. **GitHub App 생성**:
   - Organization Settings → Developer settings → GitHub Apps → New GitHub App
   - Webhook URL: SAM 배포 후 출력되는 API Gateway URL
   - Webhook secret: template.yaml의 GitHubWebhookSecret 파라미터와 동일한 값

2. **권한 설정**:
   ```
   Repository permissions:
   - Issues: Read & Write
   - Pull requests: Read & Write  
   - Contents: Read & Write
   - Metadata: Read
   
   Subscribe to events:
   - Issue comments
   ```

3. **설치**: Organization에 GitHub App 설치

### 환경변수 관리 (보안)

Private Key를 base64로 인코딩:
```bash
# Private key를 base64로 인코딩
cat your-private-key.pem | base64 -w 0
```

- **장점**: 각 서비스 레포에 리스너 불필요, 중앙 집중 관리
- **보안**: GitHub App 인증, Webhook signature 검증
- **확장성**: Lambda 자동 스케일링, API Gateway 높은 처리량

---

# 4) ROLE ARN / ECR 규칙 / 포트·네임스페이스 가이드

## 4-1. **ROLE ARN(빌드/푸시용 OIDC Role)** — 무엇을 줘야 하나?

- **용도**: GitHub Actions 러너가 **ECR 로그인+푸시**만 할 수 있도록
- **신뢰 정책(Trust policy)** — OIDC (예시)

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::768157413559:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": [
          "repo:barunntechnicaloffice/*:ref:refs/heads/main",
          "repo:barunntechnicaloffice/*:pull_request"
        ]
      }
    }
  }]
}

```

- **권한 정책(최소 권한, ECR 푸시 전용)**

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage"
    ],
    "Resource": "*"
  }]
}

```

> 이미 쓰고 있는 arn:aws:iam::768157413559:role/github-oidc-768157413559-ap-northeast-2-shared-role 그대로 입력하면 됩니다. (리소스 범위를 특정 ECR로 좁히고 싶으면 Resource에 해당 ECR ARN들로 제한 가능)
> 

## 4-2. **ECR 리포 규칙**

- 이미 ECR을 만들어 두었다고 했으니, **폼에서 이름을 입력받아 그대로 사용**하게 설계했습니다.
- 추천 규칙: **ECR = 레포명** (충돌 감소, 자동화 간단). 다르면 폼에서 ECR 이름을 따로 받으니 문제 없음.

## 4-3. **포트 / 네임스페이스**

- 기본값: `port=3000`, `namespace=app`
- **개발자가 폼에서 오버라이드** 가능(위 폼/워크플로우 반영됨)
- `infra-apps` 등록에도 `namespace` 반영

---

# 5) Bot 명령(방법 A vs B) 선택 요령

- **방법 A (GitHub App)**
    - 장점: **조직 전체 댓글**을 한 곳에서 처리(레포별 리스너 불필요)
    - 단점: 앱 호스팅 필요(Workers/Lambda 등)
- **방법 B (레포별 리스너 WF + repository_dispatch)**
    - 장점: 호스팅 불필요, 전부 Actions 안에서 해결
    - 단점: 모든 레포에 리스너를 한 번씩 보급해야 함

지금은 **A**로 가면 UX 최고, 운영도 한 군데서 끝. 호스팅이 부담이면 **B**부터 시작해도 충분함.

---

# 6) AWS 공식 문서 참조 및 배포 가이드

## 6-1. AWS 공식 문서 참조

### SAM (Serverless Application Model)
- **AWS SAM 개발자 가이드**: https://docs.aws.amazon.com/serverless-application-model/
- **Lambda Function URLs**: https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html
- **API Gateway Integration**: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-integrations.html

### GitHub 공식 문서
- **GitHub Apps**: https://docs.github.com/en/apps
- **Webhooks**: https://docs.github.com/en/webhooks
- **GitHub Actions**: https://docs.github.com/en/actions

### 배포 체크리스트

```bash
# 1. AWS CLI 설치 및 설정
aws configure

# 2. SAM CLI 설치
pip install aws-sam-cli

# 3. 프로젝트 초기화
sam init --runtime nodejs18.x --name github-bot-lambda

# 4. 코드 작성 후 빌드
sam build

# 5. 로컬 테스트 (선택사항)
sam local start-api

# 6. 배포
sam deploy --guided

# 7. CloudFormation 스택 확인
aws cloudformation describe-stacks --stack-name github-bot-lambda
```

## 6-2. 필요한 GitHub 시크릿 설정

### scaffold-ops 저장소 시크릿 설정

Repository Settings → Secrets and variables → Actions에서 다음 시크릿들을 설정:

```
GITHUB_APP_ID=1927907
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA...
[Your private key content here]
...
-----END RSA PRIVATE KEY-----

GITHUB_APP_INSTALLATION_ID=12345678
```

시크릿 값 확인 방법:
- **APP_ID**: GitHub App 설정 페이지에서 확인
- **PRIVATE_KEY**: GitHub App에서 생성한 Private Key (.pem 파일 내용 전체)
- **INSTALLATION_ID**: App 설치 후 URL에서 확인 또는 API로 조회

## 6-3. 보안 모범 사례

### AWS Secrets Manager 사용 (권장)
```yaml
# template.yaml에 추가
GitHubAppSecrets:
  Type: AWS::SecretsManager::Secret
  Properties:
    Description: GitHub App credentials
    SecretString: !Sub |
      {
        "app_id": "${GitHubAppId}",
        "private_key": "${GitHubAppPrivateKey}",
        "webhook_secret": "${GitHubWebhookSecret}"
      }
```

### Lambda에서 Secrets Manager 사용
```javascript
const AWS = require('aws-sdk');
const secretsManager = new AWS.SecretsManager();

async function getGitHubCredentials() {
    const secret = await secretsManager.getSecretValue({
        SecretId: process.env.GITHUB_SECRETS_ARN
    }).promise();
    return JSON.parse(secret.SecretString);
}
```

---

# 7) 최종 동작 흐름(요약)

1. **신규**: `scaffold-ops` → **New Service** 이슈 작성
    
    → 새 레포 생성 + deploy.yml/helm 주입
    
    → `infra-apps`에 등록 PR
    
    → 머지되면 ArgoCD가 앱 생성/동기화
    
    → 서비스 레포에 push → **중앙 재사용 WF**가 빌드/푸시
    
2. **기존**: 레포 이슈/댓글에 `/enable-cicd` (Bot A) **또는** `scaffold-ops` → **Adopt Existing** 이슈
    
    → 대상 레포에 deploy.yml/helm **PR**
    
    → `infra-apps` 등록 PR
    
    → 머지 후부터 배포 파이프라인 가동
