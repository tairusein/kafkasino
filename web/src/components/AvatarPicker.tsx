import { AVATARS, avatarUrl } from '../lib/avatars';

interface AvatarPickerProps {
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
}

/** Accessible radio-group of the 10 avatars (arrow keys work natively via real radio inputs). */
export function AvatarPicker({ value, onChange, disabled }: AvatarPickerProps) {
  return (
    <div className="avatar-picker" role="radiogroup" aria-label="Choose your avatar">
      {AVATARS.map((a) => {
        const selected = value === a.id;
        return (
          <label key={a.id} className={`avatar-option${selected ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name="avatar"
              value={a.id}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(a.id)}
            />
            <span className="avatar-option__img">
              <img src={avatarUrl(a.id)} alt={`${a.title} — ${a.name}`} width={96} height={96} draggable={false} />
            </span>
            <span className="avatar-option__title">{a.title}</span>
          </label>
        );
      })}
    </div>
  );
}
