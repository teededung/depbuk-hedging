# Input Label Patterns

Pattern 1 — Floating Label (preferred for single inputs):

```svelte
<label class="floating-label">
	<span>Email</span>
	<input type="email" placeholder="mail@example.com" class="input w-full" />
</label>
```

Pattern 2 — Fieldset (for grouped inputs):

```svelte
<fieldset class="fieldset">
	<legend class="fieldset-legend">Preferences</legend>
	<select class="select w-full">...</select>
	<p class="label">Helper text</p>
</fieldset>
```

Checkbox & Toggle — always wrap in a label:

```svelte
<label class="flex cursor-pointer items-center gap-3">
	<input type="checkbox" class="checkbox" />
	<span>Enable notifications</span>
</label>
```

Rules:

- NEVER use a plain `<label>` for text inputs — always use `floating-label`
- ALWAYS add `w-full` to inputs inside floating-label
- Do NOT add extra border helper classes — DaisyUI defaults are sufficient
