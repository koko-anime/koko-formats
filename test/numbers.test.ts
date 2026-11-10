import { describe, expect, test } from 'bun:test';
import { expandNumbers } from '../src/numbers/index.ts';

const x = (s: string) => expandNumbers(s).text;
const codes = (s: string) => expandNumbers(s).expansions.map((e) => e.code);

describe('Koko-ASS §4.3 — przykłady ze specyfikacji', () => {
  test('wzorzec 11 z przyimkiem', () => expect(x('o 3 kotach')).toBe('o trzech kotach'));
  test('godzina', () => {
    expect(x('o 15:30')).toBe('o piętnastej trzydzieści');
    expect(x('15:05')).toBe('piętnasta zero pięć');
    expect(x('7:00')).toBe('siódma');
    expect(x('na 21:00')).toBe('na dwudziestą pierwszą');
    expect(x('przed 23:00')).toBe('przed dwudziestą trzecią');
  });
  test('rok z r. na końcu zdania', () => expect(x('w 2024 r.')).toBe('w dwa tysiące dwudziestym czwartym roku.'));
  test('rok po „roku”', () => expect(x('roku 1453')).toBe('roku tysiąc czterysta pięćdziesiątego trzeciego'));
  test('porządkowy', () => {
    expect(x('27. odcinek')).toBe('dwudziesty siódmy odcinek');
    expect(codes('27. odcinek')).toEqual(['KK204']);
  });
  test('procent i waluty', () => {
    expect(x('5%')).toBe('pięć procent');
    expect(x('100 ¥')).toBe('sto jenów');
    expect(x('$5')).toBe('pięć dolarów');
    expect(x('1 €')).toBe('jedno euro');
    expect(x('2,5 zł')).toBe('dwa przecinek pięć złotego');
    expect(x('o 1 zł')).toBe('o jednym złotym');
    expect(x('22 zł')).toBe('dwadzieścia dwa złote');
  });
  test('wiodące zero, ułamki, minus', () => {
    expect(x('007')).toBe('zero zero siedem');
    expect(x('2,25')).toBe('dwa przecinek dwadzieścia pięć');
    expect(x('-5')).toBe('minus pięć');
  });
  test('tysiące i złożenia', () => {
    expect(x('1 500')).toBe('tysiąc pięćset');
    expect(x('o 23 kotach')).toBe('o dwudziestu trzech kotach');
    expect(x('do 21')).toBe('do dwudziestu jeden');
    expect(x('22000')).toBe('dwadzieścia dwa tysiące');
    expect(x('12000')).toBe('dwanaście tysięcy');
    expect(x('25000')).toBe('dwadzieścia pięć tysięcy');
    expect(x('1900. rok')).toBe('tysiąc dziewięćsetny rok');
  });
  test('bez zmian: 1080p, zakres, data', () => {
    expect(x('S2 1080p 3–4 15.03.2024')).toBe('S2 1080p 3–4 15.03.2024');
    expect(codes('S2 1080p 3–4 15.03.2024')).toEqual(['KK202', 'KK202', 'KK202', 'KK202']);
  });
  test('rodzaj i mianownik domyślny → KK204', () => {
    expect(codes('mam 2 koty')).toEqual(['KK204']);
    expect(codes('o 12 kotach')).toEqual(['KK203']);
    expect(codes('o 2 kotach')).toEqual(['KK204']);
    expect(codes('z 5 kotami')).toEqual(['KK204']);
  });
  test('limit miliarda', () => expect(x('1000000000')).toBe('jeden zero zero zero zero zero zero zero zero zero'));
});
