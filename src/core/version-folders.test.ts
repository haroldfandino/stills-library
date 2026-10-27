import { describe, expect, it } from 'vitest';
import type { Video } from '../shared/contracts';
import { planVersionFolders, planDeliveryFolders } from './version-folders';

type Input = Pick<Video, 'id' | 'path' | 'name' | 'variant'>;
function video(id: string, name: string, folder = '', variant?: string): Input {
  return { id, name, path: `Z:\\Filmkraft\\01_ActiveProjects\\[1240]Mustela_2026\\11_FINAL_DELIVERY\\01_VIDEOS\\${folder ? `${folder}\\` : ''}${name}`, variant };
}

describe('creative version delivery folders', () => {
  it('preserves the eight Mustela source labels, including the SPF file in SummerEssentials', () => {
    const labels = ['01_SummerEssentials', '02_GentleCleansingGel', '03_KeyClaims', '04_NewBornDaily',
      '05_NoRinse', '06_Stelatopia', '07_WinterRoutine', '08_HydraBaby'];
    const inputs = labels.map((folder, index) => video(String(index),
      `Mustela_${folder.slice(3)}${index === 0 ? '-SPF' : ''}_30_4K_Social_H264.mp4`, `${folder}\\Social\\16x9`));
    const plan = planVersionFolders(inputs, '[1240]Mustela_2026');
    expect([...plan.values()]).toEqual(labels);
    expect(plan.get('0')).toBe('01_SummerEssentials');
    // The same algorithm recognizes Windows drive/UNC paths on every test OS.
    expect([...planVersionFolders(inputs.map(item => ({ ...item, path: item.path.replace('Z:', '\\\\server\\share') })), '[1240]Mustela_2026')]).toEqual([...plan]);
  });

  it('chooses the closest creative folder and ignores numbered channel, codec, and aspect folders', () => {
    const inputs = [video('a', 'Mustela_SPFA_30.mp4', '01_Campaign\\07_SummerEssentials\\02_Social\\03_H264\\04_16x9'),
      video('b', 'Mustela_Gel_30.mp4', '01_Campaign\\08_GentleCleansingGel\\01_ProRes_422_HQ')];
    expect([...planVersionFolders(inputs, 'Mustela').values()]).toEqual(['07_SummerEssentials', '08_GentleCleansingGel']);
  });

  it('numbers flat Airwaav creative labels deterministically without delivery tags', () => {
    const inputs = ['Offer', 'NoOffer', 'Amazon'].map(label => video(label,
      `Airwaav_Brager-${label}_30_4K_Social_H264.mp4`, 'Social'));
    const plan = planVersionFolders(inputs, '[203SB]Airwaav_Brager_PremiumAd');
    expect(Object.fromEntries(plan)).toEqual({ Offer: '03_Offer', NoOffer: '02_NoOffer', Amazon: '01_Amazon' });
    expect(Object.fromEntries(planVersionFolders([...inputs].reverse(), '[203SB]Airwaav_Brager_PremiumAd'))).toEqual(Object.fromEntries(plan));
  });

  it('keeps encodes, durations, and aspect ratios of one creative in one folder', () => {
    const inputs = [
      video('offer-wide', 'Airwaav_Brager-Offer_30_4K_Social_H264.mp4'),
      video('offer-tall', 'Airwaav_Brager-Offer_15_1080x1920_TV_ProRes.mov'),
      video('offer-square', 'Airwaav_Brager-Offer_6s_1x1_Social_H265.mp4'),
      video('offer-portrait', 'Airwaav_Brager-Offer_30sec_4_5_Social_H264.mp4'),
      video('no-offer', 'Airwaav_Brager-NoOffer_30_16x9_Social_H264.mp4'),
    ];
    const plan = planVersionFolders(inputs, 'Airwaav_Brager');
    expect(new Set(inputs.slice(0, 4).map(item => plan.get(item.id)))).toEqual(new Set(['02_Offer']));
    expect(plan.get('no-offer')).toBe('01_NoOffer');
  });

  it('keeps legacy flat delivery for one creative with multiple aspects or one numbered source folder', () => {
    expect(planVersionFolders([
      video('wide', 'Airwaav_Brager_30_4K_Social_H264.mp4'),
      video('square', 'Airwaav_Brager_15_Square_ProRes.mov'),
      video('tall', 'Airwaav_Brager_long-form_9x16_H264.mp4'),
    ], 'Airwaav_Brager').size).toBe(0);
    expect(planVersionFolders([
      video('wide', 'Mustela_SummerEssentials-SPF_30_16x9_H264.mp4', '01_SummerEssentials'),
      video('tall', 'Mustela_SummerEssentials_15_9x16_H264.mp4', '01_SummerEssentials'),
    ], 'Mustela').size).toBe(0);
    expect(planVersionFolders([], 'Empty').size).toBe(0);
  });

  it('uses explicit variants and supports duration-suffixed Net32 variants', () => {
    expect(Object.fromEntries(planVersionFolders([
      video('a', 'Brand_30_16x9_H264.mp4', '', 'Offer'),
      video('b', 'Brand_30_16x9_H264.mp4', '', 'NoOffer'),
    ], 'Brand'))).toEqual({ a: '02_Offer', b: '01_NoOffer' });
    expect(Object.fromEntries(planVersionFolders([
      video('a', 'Net32_2026_Brand_Refresh_30A_4K_Social_H264.mp4'),
      video('b', 'Net32_2026_Brand_Refresh_30B_4K_Social_H264.mp4'),
    ], 'Net32_2026_Brand_Refresh'))).toEqual({ a: '01_A', b: '02_B' });
  });

  it('removes a common filename prefix absent from the Sheet title', () => {
    expect(Object.fromEntries(planVersionFolders([
      video('a', 'Client_Campaign_ProductOne_30_H264.mp4'),
      video('b', 'Client_Campaign_ProductTwo_30_H264.mp4'),
    ], 'Unrelated Sheet title'))).toEqual({ a: '01_ProductOne', b: '02_ProductTwo' });
  });

  it('does not treat numbered project/archive folders outside the delivery tree as versions', () => {
    const inputs = [video('a', 'Brand_Offer_30_H264.mp4'), video('b', 'Brand_NoOffer_30_H264.mp4')]
      .map(item => ({ ...item, path: `C:/01_Archive/02_Films/${item.name}` }));
    expect([...planVersionFolders(inputs, 'Brand').values()]).toEqual(['02_Offer', '01_NoOffer']);
  });

  it('disambiguates sanitized names with stable numbering and reserves source numbering', () => {
    const inputs = [video('a', 'Brand_30.mp4', '', 'Offer?'), video('b', 'Brand_30.mp4', '', 'Offer*'),
      video('c', 'Brand_Gel_30.mp4', '01_Gel')];
    const plan = planVersionFolders(inputs, 'Brand');
    expect(plan.get('c')).toBe('01_Gel');
    expect(new Set(plan.values()).size).toBe(3);
    for (const label of plan.values()) expect(label).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]|[. ]$/);
    expect(Object.fromEntries(planVersionFolders([...inputs].reverse(), 'Brand'))).toEqual(Object.fromEntries(plan));
  });

  it('rejects unsafe source labels and conflicting source labels for one creative', () => {
    expect(() => planVersionFolders([video('a', 'A.mp4', '01_Bad?'), video('b', 'B.mp4', '02_Good')], 'Brand')).toThrow(/Unsafe source/);
    expect(() => planVersionFolders([video('a', 'A.mp4', '01_..'), video('b', 'B.mp4', '02_Good')], 'Brand')).toThrow(/Unsafe source/);
    expect(() => planVersionFolders([video('a', 'A.mp4', '01_Offer'), video('b', 'B.mp4', '02_Offer')], 'Brand')).toThrow(/Conflicting source/);
    expect(() => planVersionFolders([video('a', 'A.mp4', '01_Offer'), video('b', 'B.mp4', '02_Offer'), video('c', 'C.mp4', '03_Amazon')], 'Brand')).toThrow(/Conflicting source/);
    expect(() => planVersionFolders([video('a', 'A.mp4'), video('a', 'B.mp4')], 'Brand')).toThrow(/Duplicate video ID/);
  });
});


describe('aspect-ratio delivery folders', () => {
  it('omits aspect folders for a single ratio, including multiple versions', () => {
    const videos = [video('a', 'Brand_Offer_30.mp4'), video('b', 'Brand_NoOffer_30.mp4')].map(v => ({ ...v, aspect: 'horizontal' }));
    expect(planDeliveryFolders(videos, 'Brand')).toEqual(planVersionFolders(videos, 'Brand'));
  });
  it('places versions inside project-wide aspect folders', () => {
    const videos = [
      { ...video('a', 'Brand_Offer_30_16x9.mp4'), aspect: 'horizontal' },
      { ...video('b', 'Brand_NoOffer_30_1x1.mp4'), aspect: 'square' },
      { ...video('c', 'Brand_Offer_30_4x5.mp4'), aspect: '4x5' },
      { ...video('d', 'Brand_Offer_30_9x16.mp4'), aspect: 'vertical' },
    ];
    expect(Object.fromEntries(planDeliveryFolders(videos, 'Brand'))).toEqual({ a: 'Horizontal/02_Offer', b: 'Square/01_NoOffer', c: '4x5/02_Offer', d: 'Vertical/02_Offer' });
  });
  it('uses only aspect folders for one creative and rejects unknown mixed ratios', () => {
    const videos = [{ ...video('a', 'Brand_30_16x9.mp4'), aspect: 'horizontal' }, { ...video('b', 'Brand_30_1x1.mp4'), aspect: 'square' }];
    expect(Object.fromEntries(planDeliveryFolders(videos, 'Brand'))).toEqual({ a: 'Horizontal', b: 'Square' });
    expect(() => planDeliveryFolders([videos[0], { ...videos[1], aspect: 'unknown' }], 'Brand')).toThrow(/unknown aspect/);
  });
});
