import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { db, initializeDatabase } from './db.js';
const scrypt=promisify(scryptCallback);
async function hidden(prompt){
  if(!stdin.isTTY||typeof stdin.setRawMode!=='function')throw new Error('Run this command inside the VS Code terminal so the new password can be hidden while you type.');
  return new Promise((resolve,reject)=>{
    let value='';
    const finish=(error)=>{stdin.removeListener('data',onData);stdin.setRawMode(false);stdout.write('\n');if(error)reject(error);else resolve(value);};
    const onData=(chunk)=>{for(const character of chunk){if(character==='\u0003'){finish(new Error('Password reset cancelled.'));return;}if(character==='\r'||character==='\n'){finish();return;}if(character==='\u007f'||character==='\b'){if(value.length){value=value.slice(0,-1);stdout.write('\b \b');}continue;}if(character>=' '){value+=character;stdout.write('*');}}};
    stdout.write(prompt);stdin.setRawMode(true);stdin.setEncoding('utf8');stdin.resume();stdin.on('data',onData);
  });
}
try{
  await initializeDatabase();
  const line=createInterface({input:stdin,output:stdout});
  const email=(await line.question('Account email: ')).trim().toLowerCase();
  line.close();
  const user=await db.get('SELECT id FROM users WHERE LOWER(email)=LOWER(?)',email);
  if(!user)throw new Error('No account was found for that email. Check the address and try again.');
  const password=await hidden('New password (at least 10 characters): ');
  if(password.length<10||password.length>128)throw new Error('Choose a password between 10 and 128 characters.');
  const confirm=await hidden('Type the new password again: ');
  if(password!==confirm)throw new Error('The passwords did not match. Run the command again.');
  const salt=randomBytes(16).toString('hex'),passwordHash=(await scrypt(password,salt,64)).toString('hex');
  await db.run('UPDATE users SET salt=?,password_hash=? WHERE id=?',salt,passwordHash,user.id);
  await db.run('DELETE FROM sessions WHERE user_id=?',user.id);
  console.log('Password updated. Sign in with the new password.');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{await db.close();}
import 'dotenv/config';
