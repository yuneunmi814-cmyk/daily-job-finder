// 홈 화면에 추가했을 때 앱처럼 뜨게 하고, 신호가 약해도 마지막 목록은 보이게 한다.
//
// 주의: 화면(HTML)까지 캐시를 먼저 쓰면, 한 번 설치한 사람은 앱이 새로 배포돼도
// 영원히 옛날 화면만 보게 된다. 그래서 화면과 공고는 "새것 먼저, 안 되면 캐시",
// 아이콘처럼 안 바뀌는 것만 "캐시 먼저"로 나눈다.
const CACHE = 'jobfinder-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 새것을 먼저 받아보고, 받아지면 캐시도 갱신해둔다. 실패하면 지난번 것을 보여준다.
function networkFirst(request) {
  return fetch(request)
    .then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(request, copy));
      return res;
    })
    .catch(() => caches.match(request).then(hit => hit || caches.match('/')));
}

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 화면과 공고 목록은 항상 최신을 먼저 시도한다
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.startsWith('/api/')) {
    e.respondWith(networkFirst(request));
    return;
  }

  // 아이콘·매니페스트처럼 잘 안 바뀌는 것만 캐시를 먼저 쓴다
  e.respondWith(
    caches.match(request).then(hit => hit || fetch(request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(request, copy));
      return res;
    }))
  );
});
