import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

function readHidden(label) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(new Error('L’initialisation doit être lancée dans un terminal interactif.'));
      return;
    }

    stdout.write(label);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const finish = (result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      resolve(result);
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          reject(new Error('Initialisation interrompue.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };

    stdin.on('data', onData);
  });
}

async function main() {
  const terminal = createInterface({ input: stdin, output: stdout });
  const enteredUrl = await terminal.question(
    `Adresse du site/API [http://127.0.0.1:8788] : `,
  );
  terminal.close();

  const baseUrl = (enteredUrl.trim() || 'http://127.0.0.1:8788').replace(/\/+$/, '');
  const setupSecret = await readHidden('Secret initial (saisie masquée) : ');
  if (setupSecret.length < 32) {
    throw new Error('Le secret initial doit contenir au moins 32 caractères.');
  }

  const pins = {
    ali: '123456',
    zakaria: '999999',
    idrissa: '190619',
  };

  const response = await fetch(`${baseUrl}/api/setup/pins`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-setup-secret': setupSecret,
    },
    body: JSON.stringify({ pins }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Échec de l’initialisation (HTTP ${response.status}).`);
  }
  stdout.write('Les trois codes ont été enregistrés. Gardez-les en lieu sûr.\n');
}

main().catch((error) => {
  stdout.write(`Erreur : ${error instanceof Error ? error.message : 'initialisation impossible'}\n`);
  process.exitCode = 1;
});