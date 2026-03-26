export default function Home() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', fontFamily: 'sans-serif' }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: '2rem', marginBottom: '1rem' }}>Docker Manager 배포 테스트</h1>
        <p style={{ color: '#666' }}>이 페이지가 보이면 배포 성공입니다.</p>
        <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: '#999' }}>
          {new Date().toISOString()}
        </p>
      </div>
    </div>
  );
}
