# AI 홍보 영상 어워드

직원용 화면은 `index.html`, 관리자 화면은 `admin.html`로 구성된 HTML 중심 사이트입니다.
뒤에서는 `server.js`가 사원번호 검증, 이름 자동 확인, 투표 저장, 관리자 인증을 처리합니다.

## 로컬 실행

```powershell
npm install
npm start
```

- 직원용: `http://localhost:3000`
- 관리자용: `http://localhost:3000/admin`

## 영구 배포

이 프로젝트는 `render.yaml` 기준으로 Render에 바로 배포할 수 있게 구성되어 있습니다.

### 배포 순서

1. GitHub 저장소에 업로드
2. Render에서 `New +` → `Blueprint`
3. GitHub 저장소 연결
4. Render 배포 완료 후 URL 사용

## 데이터 파일

- `data/videos.json`
- `data/votes.json`
- `data/state.json`
- `data/employees.json`
