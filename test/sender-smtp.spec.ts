/** @file-guide
 * 목적: 실제 Nodemailer와 LiveSender의 SMTP 인증·본문·Buffer 첨부·수신 거절 계약을 검증한다.
 * 책임/재사용: node:net 루프백 서버만 사용하며 외부 SMTP·환경 자격·실제 연락처를 읽거나 발송하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, type Server, type Socket } from 'node:net';
import { LiveSender } from '../src/modules/notify/live.sender';

const USER = 'smtp-fixture@example.test';
const PASSWORD = 'local-only-smtp-fixture';

interface SmtpFixture {
  server: Server;
  sockets: Set<Socket>;
  messages: string[];
  commands: string[];
  authenticated: boolean;
  port: number;
}

/** 실제 TCP·SMTP를 통과하되 인증 원문은 기록하지 않는다. TLS/provider 전달 여부를 증명하는 시험은 아니다. */
async function smtpFixture(rejectedRecipient?: string): Promise<SmtpFixture> {
  const fixture: SmtpFixture = {
    server: createServer(), sockets: new Set(), messages: [], commands: [], authenticated: false, port: 0,
  };
  fixture.server.on('connection', (socket) => {
    fixture.sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('close', () => fixture.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffer = '';
    let data: string[] | null = null;
    let auth: 'plain' | 'user' | 'password' | null = null;
    let loginUserValid = false;
    const reply = (value: string) => socket.write(`${value}\r\n`);
    const authenticate = (valid: boolean) => {
      fixture.authenticated = valid;
      auth = null;
      reply(valid ? '235 2.7.0 Authenticated' : '535 5.7.8 Authentication failed');
    };
    const plain = (encoded: string) => {
      const [, user, password] = Buffer.from(encoded, 'base64').toString('utf8').split('\0');
      authenticate(user === USER && password === PASSWORD);
    };
    reply('220 localhost ESMTP synthetic fixture');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (data) {
          if (line === '.') {
            fixture.messages.push(data.join('\r\n'));
            data = null;
            reply('250 2.0.0 queued-fixture');
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        if (auth === 'plain') {
          plain(line);
          continue;
        }
        if (auth === 'user') {
          loginUserValid = Buffer.from(line, 'base64').toString('utf8') === USER;
          auth = 'password';
          reply('334 UGFzc3dvcmQ6');
          continue;
        }
        if (auth === 'password') {
          authenticate(loginUserValid && Buffer.from(line, 'base64').toString('utf8') === PASSWORD);
          continue;
        }
        const command = line.split(' ', 1)[0].toUpperCase();
        fixture.commands.push(command);
        if (command === 'EHLO' || command === 'HELO') {
          reply('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1048576');
        } else if (command === 'AUTH') {
          if (line.startsWith('AUTH PLAIN ')) {
            plain(line.slice('AUTH PLAIN '.length));
          } else if (line === 'AUTH PLAIN') {
            auth = 'plain';
            reply('334 ');
          } else {
            auth = 'user';
            reply('334 VXNlcm5hbWU6');
          }
        } else if (command === 'MAIL') {
          reply(fixture.authenticated ? '250 2.1.0 Sender accepted' : '530 5.7.0 Authentication required');
        } else if (command === 'RCPT') {
          reply(rejectedRecipient
            ? `550 5.1.1 Recipient rejected ${rejectedRecipient}`
            : '250 2.1.5 Recipient accepted');
        } else if (command === 'DATA') {
          data = [];
          reply('354 End data with <CRLF>.<CRLF>');
        } else if (command === 'QUIT') {
          socket.end('221 2.0.0 Bye\r\n');
        } else if (command === 'RSET' || command === 'NOOP') {
          reply('250 2.0.0 OK');
        } else {
          reply('500 5.5.1 Unsupported fixture command');
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    fixture.server.once('error', reject);
    fixture.server.listen(0, '127.0.0.1', resolve);
  });
  const address = fixture.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('SMTP fixture loopback address unavailable');
  }
  fixture.port = address.port;
  return fixture;
}

const sender = (fixture: SmtpFixture) => new LiveSender(new ConfigService({
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(fixture.port), SMTP_USER: USER, SMTP_PASS: PASSWORD, MAIL_FROM: USER,
}));

describe('실제 Nodemailer SMTP — 외부 발송 없는 루프백 통합', () => {
  let fixture: SmtpFixture | undefined;
  afterEach(async () => {
    jest.restoreAllMocks();
    if (fixture) {
      for (const socket of fixture.sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => fixture?.server.close((error) => error ? reject(error) : resolve()));
      fixture = undefined;
    }
  });

  it('실제 인증 뒤 text와 Buffer 첨부를 MIME으로 보내고 messageId를 반환한다', async () => {
    fixture = await smtpFixture();
    const attachment = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255]);
    const result = await sender(fixture).send({
      channel: 'email', to: 'receiver.fixture@example.test', subject: 'Synthetic SMTP fixture', body: 'synthetic body only',
      attachments: [{ filename: 'fixture.bin', content: attachment, contentType: 'application/octet-stream' }],
    });
    expect(result).toMatchObject({ configured: true, ok: true, error: null });
    expect(result.providerId).toEqual(expect.any(String));
    expect(fixture.authenticated).toBe(true);
    expect(fixture.commands).toEqual(expect.arrayContaining(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA']));
    expect(fixture.messages).toHaveLength(1);
    const message = fixture.messages[0];
    expect(message).toContain(`Message-ID: ${result.providerId}`);
    expect(message).toContain('Subject: Synthetic SMTP fixture');
    expect(message).toContain('Content-Type: multipart/mixed');
    expect(message).toContain('synthetic body only');
    const boundary = message.match(/boundary="([^"]+)"/)?.[1];
    expect(boundary).toBeDefined();
    const part = message.split(`--${boundary}`).find((item) => /filename="?fixture\.bin"?/.test(item));
    expect(part).toContain('Content-Type: application/octet-stream');
    expect(part).toContain('Content-Transfer-Encoding: base64');
    const payload = part?.split('\r\n\r\n')[1]?.replace(/\s/g, '') ?? '';
    expect(Buffer.from(payload, 'base64')).toEqual(attachment);
  });

  it('수신자 550 거절은 ok=false이고 수신처 원문을 결과나 로그에 남기지 않는다', async () => {
    const to = 'rejected.fixture@example.test';
    fixture = await smtpFixture(to);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const result = await sender(fixture).send({ channel: 'email', to, subject: 'Synthetic reject', body: 'rejected body only' });
    expect(result).toMatchObject({ configured: true, ok: false, providerId: null });
    expect(result.error).toContain('550');
    expect(result.error).not.toContain(to);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(to);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('rejected body only');
    expect(fixture.messages).toHaveLength(0);
    expect(fixture.commands).not.toContain('DATA');
  });
});
