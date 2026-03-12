# AI 홍보 영상 어워드

직원용 화면은 [index.html](/c:/Users/IPARK/Desktop/AI%20Project/07.%20AI%20홍보%20영상%20투표%20사이트/index.html), 관리자 화면은 [admin.html](/c:/Users/IPARK/Desktop/AI%20Project/07.%20AI%20홍보%20영상%20투표%20사이트/admin.html)로 구성된 HTML 중심 사이트입니다.  
뒤에서는 [server.js](/c:/Users/IPARK/Desktop/AI%20Project/07.%20AI%20홍보%20영상%20투표%20사이트/server.js)가 사원번호 검증, 투표 저장, 관리자 인증을 처리합니다.

## 로컬 실행

```powershell
npm install
npm start
```

- 직원용: `http://localhost:3000`
- 관리자용: `http://localhost:3000/admin`

## 영구 배포

PC가 꺼져 있어도 계속 접속되게 하려면 외부 서버에 배포해야 합니다.  
이 프로젝트는 [render.yaml](/c:/Users/IPARK/Desktop/AI%20Project/07.%20AI%20홍보%20영상%20투표%20사이트/render.yaml) 기준으로 Render에 바로 올릴 수 있게 맞춰져 있습니다.

### 배포 순서

1. 이 프로젝트 폴더를 GitHub 저장소에 업로드합니다.
2. Render에서 `New +` → `Blueprint`를 선택합니다.
3. GitHub 저장소를 연결합니다.
4. Render가 `render.yaml`을 읽어 웹 서비스와 데이터 디스크를 생성합니다.
5. 배포가 끝나면 Render URL이 발급되고, 그 주소는 PC가 꺼져 있어도 계속 유지됩니다.

## 데이터 파일

- 출품 영상: [data/videos.json](/c:/Users/IPARK/Desktop/AI%20Project/07.%20AI%20홍보%20영상%20투표%20사이트/data/videos.json)
- 투표 데이터: [data/votes.json](/c:/Users/IPARK/Desktop/AI%20Project/07.%20AI%20홍보%20영상%20투표%20사이트/data/votes.json)
- 상태 데이터: [data/state.json](/c:/Users/IPARK/Desktop/AI%20Project/07.%20AI%20홍보%20영상%20투표%20사이트/data/state.json)
- 직원 명단: [data/employees.json](/c:/Users/IPARK/Desktop/AI%20Project/07.%20AI%20홍보%20영상%20투표%20사이트/data/employees.json)
