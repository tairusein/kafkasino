import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSound } from '../audio/SoundProvider';
import { useAuth } from '../auth/AuthProvider';
import { InteractiveEmoteStage } from '../components/InteractiveEmotePreview';
import { friendlyError } from '../lib/errors';
import { formatChips } from '../lib/format';
import { DEFAULT_CARD_BACK_URL, EMOTE_SPECS, resolveCardBackUrl } from '../lib/shop';
import { supabase } from '../lib/supabase';
import type { InteractiveEmoteAnimation, ShopItem, UserItem } from '../lib/types';
import { useWallet } from '../wallet/WalletProvider';

const OPPONENT_AVATARS: readonly string[] = ['lion', 'wolf', 'bear', 'panther', 'eagle'];

export function ShopPage() {
  const { user, profile, refreshProfile } = useAuth();
  const { balance, refresh: refreshWallet } = useWallet();
  const { sound } = useSound();

  const [items, setItems] = useState<ShopItem[]>([]);
  const [inventory, setInventory] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [packCounts, setPackCounts] = useState<Record<string, number>>({});
  const [previewKeys, setPreviewKeys] = useState<Record<string, number>>({});
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const loadShop = useCallback(async () => {
    if (!user) return;
    const [itemsRes, invRes] = await Promise.all([
      supabase.from('shop_items').select('*').eq('is_active', true).order('sort_order', { ascending: true }),
      supabase.from('user_items').select('*').eq('user_id', user.id),
    ]);

    if (!itemsRes.error && itemsRes.data) {
      setItems(itemsRes.data as ShopItem[]);
    }
    if (!invRes.error && invRes.data) {
      const map = new Map<string, number>();
      for (const row of invRes.data as UserItem[]) {
        map.set(row.item_id, Number(row.quantity));
      }
      setInventory(map);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    void loadShop();
  }, [loadShop]);

  const cardBacks = useMemo(() => items.filter((i) => i.kind === 'card_back'), [items]);
  const emotes = useMemo(() => items.filter((i) => i.kind === 'emote'), [items]);

  const equippedCardBackItem = useMemo(
    () => cardBacks.find((c) => c.id === profile?.equipped_card_back) ?? null,
    [cardBacks, profile?.equipped_card_back],
  );

  const totalEmoteCharges = useMemo(() => {
    let sum = 0;
    for (const em of emotes) {
      sum += inventory.get(em.id) ?? 0;
    }
    return sum;
  }, [emotes, inventory]);

  function triggerPreview(item: ShopItem) {
    const anim = item.asset?.animation ?? 'slap';
    setPreviewKeys((prev) => ({ ...prev, [item.id]: (prev[item.id] ?? 0) + 1 }));
    if (anim === 'toast') {
      sound.play('notify');
    } else if (anim === 'slap' || anim === 'punch') {
      sound.play('cardFlip');
    } else {
      sound.play('slotStop');
    }
  }

  async function onPurchase(item: ShopItem) {
    if (busyItemId) return;
    const qty = item.is_consumable ? (packCounts[item.id] ?? 1) : 1;
    setBusyItemId(item.id);
    setFeedback(null);
    sound.play('chipClick');

    const idempotencyKey =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const { error } = await supabase.rpc('purchase_item', {
      p_item_id: item.id,
      p_quantity: qty,
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      sound.play('lose');
      setFeedback({ kind: 'error', text: friendlyError(error) });
    } else {
      sound.play('win');
      await Promise.all([loadShop(), refreshWallet()]);
      if (item.kind === 'emote') {
        triggerPreview(item);
        setFeedback({
          kind: 'ok',
          text: `Acquired +${qty * item.grant_quantity} charges of "${item.name}".`,
        });
      } else {
        setFeedback({
          kind: 'ok',
          text: `"${item.name}" added to your collection. You can equip it for all card tables below.`,
        });
      }
    }
    setBusyItemId(null);
  }

  async function onEquipCardBack(itemId: string | null) {
    if (busyItemId) return;
    setBusyItemId(itemId ?? 'default');
    setFeedback(null);

    const { error } = await supabase.rpc('equip_card_back', { p_item_id: itemId });
    if (error) {
      setFeedback({ kind: 'error', text: friendlyError(error) });
    } else {
      sound.play('cardShuffle');
      await refreshProfile();
      setFeedback({
        kind: 'ok',
        text: itemId ? 'Custom card back equipped for your tables.' : 'Restored the House Standard card back.',
      });
    }
    setBusyItemId(null);
  }

  if (loading) {
    return (
      <div className="page">
        <p className="muted">Opening the House Shop…</p>
      </div>
    );
  }

  const senderAvatar = profile?.avatar_id ?? 'fox';

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">House Haberdashery &amp; Vault</p>
          <h1>Customization Shop</h1>
        </div>
        <div className="shop-loadout-pill">
          <img
            src={equippedCardBackItem ? resolveCardBackUrl(equippedCardBackItem) : DEFAULT_CARD_BACK_URL}
            alt="Equipped card back"
            width={34}
            height={48}
          />
          <div>
            <div className="muted small">Equipped Card Back</div>
            <strong>{equippedCardBackItem ? equippedCardBackItem.name : 'House Standard'}</strong>
          </div>
          {equippedCardBackItem && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void onEquipCardBack(null)}
              disabled={busyItemId !== null}
            >
              Use Default
            </button>
          )}
        </div>
      </header>

      {feedback && (
        <p className={feedback.kind === 'ok' ? 'form-ok shop-feedback' : 'form-error shop-feedback'} role="status">
          {feedback.text}
        </p>
      )}

      {/* Section 1: Custom Card Backs */}
      <section aria-label="Custom Card Backs">
        <div className="shop-section-head">
          <div>
            <p className="eyebrow">Permanent Collection</p>
            <h2>Custom Card Backs</h2>
          </div>
          <p className="muted small">
            Displayed on your deck and hole cards across Blackjack, Texas Hold&apos;em, and Durak.
          </p>
        </div>

        <div className="shop-card-backs-grid">
          {cardBacks.map((item) => {
            const owned = (inventory.get(item.id) ?? 0) > 0;
            const equipped = profile?.equipped_card_back === item.id;
            const canAfford = balance === null || balance >= item.price;
            const isBusy = busyItemId === item.id;

            return (
              <article
                key={item.id}
                className={`shop-card${equipped ? ' shop-card--equipped' : owned ? ' shop-card--owned' : ''}`}
              >
                <div className="shop-card__deck-frame">
                  <img
                    src={resolveCardBackUrl(item)}
                    alt={item.name}
                    className="shop-card__deck-img"
                    draggable={false}
                  />
                </div>

                <div className="shop-card__body">
                  <div className="row">
                    {equipped ? (
                      <span className="badge badge--open">✓ Equipped</span>
                    ) : owned ? (
                      <span className="badge">Owned</span>
                    ) : (
                      <span className="badge">{formatChips(item.price)} Chips</span>
                    )}
                  </div>

                  <h3 className="shop-card__title">{item.name}</h3>
                  <p className="muted small shop-card__desc">{item.description}</p>

                  <div className="shop-card__actions">
                    {owned ? (
                      equipped ? (
                        <button
                          type="button"
                          className="btn btn--ghost btn--block"
                          onClick={() => void onEquipCardBack(null)}
                          disabled={busyItemId !== null}
                        >
                          Unequip
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--gold btn--block"
                          onClick={() => void onEquipCardBack(item.id)}
                          disabled={busyItemId !== null}
                        >
                          {isBusy ? 'Equipping…' : 'Equip Card Back'}
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        className="btn btn--gold btn--block"
                        onClick={() => void onPurchase(item)}
                        disabled={busyItemId !== null || !canAfford}
                      >
                        {isBusy
                          ? 'Purchasing…'
                          : canAfford
                            ? `Purchase · ${formatChips(item.price)}`
                            : `Need ${formatChips(item.price)} Chips`}
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Section 2: Premium Interactive Emotes */}
      <section aria-label="Premium Interactive Emotes">
        <div className="shop-section-head">
          <div>
            <p className="eyebrow">Targeted Table Animations · {totalEmoteCharges} Charges in Vault</p>
            <h2>Premium Interactive Emotes</h2>
          </div>
          <p className="muted small">
            Target any opponent&apos;s avatar during a live session to launch an interactive animation across the table.
          </p>
        </div>

        <div className="shop-emotes-grid">
          {emotes.map((item, idx) => {
            const anim: InteractiveEmoteAnimation = item.asset?.animation ?? 'slap';
            const spec = EMOTE_SPECS[anim] ?? EMOTE_SPECS.slap;
            const charges = inventory.get(item.id) ?? 0;
            const packs = packCounts[item.id] ?? 1;
            const totalPrice = item.price * packs;
            const totalUnits = item.grant_quantity * packs;
            const canAfford = balance === null || balance >= totalPrice;
            const isBusy = busyItemId === item.id;
            const opponentAvatar =
              OPPONENT_AVATARS[idx % OPPONENT_AVATARS.length] === senderAvatar
                ? 'owl'
                : OPPONENT_AVATARS[idx % OPPONENT_AVATARS.length];

            return (
              <article key={item.id} className="shop-emote-card">
                <div className="shop-emote-card__top">
                  <div className="row">
                    <span className="badge badge--open">{spec.badge}</span>
                    <span className="badge tabular">In Vault: {charges} charges</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => triggerPreview(item)}
                    data-silent
                  >
                    ▶ Preview Animation
                  </button>
                </div>

                <InteractiveEmoteStage
                  animation={anim}
                  senderAvatarId={senderAvatar}
                  targetAvatarId={opponentAvatar}
                  playKey={previewKeys[item.id] ?? 0}
                />

                <div className="shop-emote-card__info">
                  <h3 className="shop-card__title">{item.name}</h3>
                  <p className="muted small shop-card__desc">{item.description}</p>
                </div>

                <div className="shop-emote-card__purchase">
                  <label className="shop-pack-select">
                    <span className="muted small">Pack Size</span>
                    <select
                      value={packs}
                      onChange={(e) =>
                        setPackCounts((prev) => ({ ...prev, [item.id]: Number(e.target.value) }))
                      }
                      disabled={busyItemId !== null}
                    >
                      <option value={1}>1 Pack (+{item.grant_quantity} uses) — {formatChips(item.price)}</option>
                      <option value={2}>2 Packs (+{item.grant_quantity * 2} uses) — {formatChips(item.price * 2)}</option>
                      <option value={5}>5 Packs (+{item.grant_quantity * 5} uses) — {formatChips(item.price * 5)}</option>
                    </select>
                  </label>

                  <button
                    type="button"
                    className="btn btn--gold"
                    onClick={() => void onPurchase(item)}
                    disabled={busyItemId !== null || !canAfford}
                  >
                    {isBusy
                      ? 'Purchasing…'
                      : canAfford
                        ? `Buy +${totalUnits} Uses · ${formatChips(totalPrice)}`
                        : `Insufficient Chips`}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

