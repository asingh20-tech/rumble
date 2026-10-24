import { QRCodeSVG } from 'qrcode.react';

export default function RoomQRCode({ code }) {
  const baseUrl = (import.meta.env.VITE_PUBLIC_URL || window.location.origin).replace(/\/+$/, '');
  const joinUrl = `${baseUrl}/play/${code}`;
  return (
    <div className="room-qr">
      <a className="qr-paper" href={joinUrl} aria-label={`Join room ${code}`}>
        <QRCodeSVG value={joinUrl} size={180} marginSize={4} title={`Join RUMBLE room ${code}`} />
      </a>
      <p>SCAN TO JOIN</p>
      <a href={joinUrl} className="join-url">{joinUrl}</a>
    </div>
  );
}
