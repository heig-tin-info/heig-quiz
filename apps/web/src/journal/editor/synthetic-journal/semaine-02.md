---
title: Semaine 2
draft: true
---

# Les pointeurs

Un pointeur contient une adresse. Sa taille vaut $8$ octets sur une machine 64 bits, et
l'arithmétique suit $p + k = p + k \cdot \text{sizeof}(*p)$.

$$
\sum_{i=0}^{n-1} t_i = \frac{n(n-1)}{2}
$$

## Exercices

- [ ] Écrire `swap`
- [x] Lire le chapitre 5

* Une liste à étoiles
* garde ses étoiles

Du HTML brut reste du texte : <details><summary>Indice</summary>utilisez `&x`</details>

<div class="note">
Bloc HTML brut.
</div>

## Corrigé

```
int *p = &x;
*p = 42;
```

***

Retour à l'[accueil](index.md).
