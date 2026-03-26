export const metadata = {
  title: 'Test App',
  description: 'Docker Manager 배포 테스트용',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
