# Aide-mémoire du langage C

Ce document résume la syntaxe vue au cours. Il ne remplace pas la documentation de la bibliothèque standard.

## Types et variables

| Type | Taille usuelle | Exemple |
|---|---|---|
| `char` | 1 octet | `char c = 'a';` |
| `int` | 4 octets | `int n = 42;` |
| `long` | 8 octets | `long big = 1L << 40;` |
| `double` | 8 octets | `double x = 3.14;` |

Une variable déclarée sans valeur initiale dans une fonction contient n'importe quoi : initialisez-la toujours.

## Pointeurs

Un pointeur contient l'adresse d'une variable. L'opérateur `&` donne l'adresse, l'opérateur `*` la valeur pointée.

```c
int n = 5;
int *p = &n;
*p = 7;          // n vaut maintenant 7
```

![Schéma d'un pointeur](img/pointeurs.png)

### Tableaux et pointeurs

Le nom d'un tableau se convertit en pointeur vers son premier élément : `t[i]` équivaut à `*(t + i)`.

### Chaînes de caractères

Une chaîne est un tableau de `char` terminé par le caractère nul `'\0'`. La fonction `strlen` compte les caractères sans le terminateur.

## Structures de contrôle

### Conditions

```c
if (n > 0) {
    puts("positif");
} else {
    puts("négatif ou nul");
}
```

### Boucles

La boucle `for` répète un bloc un nombre connu de fois ; la boucle `while` tant qu'une condition reste vraie.

## Fonctions

Une fonction déclare son type de retour, son nom et ses paramètres. Les paramètres sont passés par valeur : pour modifier une variable de l'appelant, passez son adresse.

<kbd>Ctrl</kbd> + <kbd>D</kbd> termine la saisie au clavier dans un terminal.

## Mémoire dynamique

`malloc` réserve une zone de mémoire, `free` la rend. Toute zone réservée doit être rendue exactement une fois.

## Complexité

Parcourir un tableau de $n$ éléments coûte $O(n)$ ; une recherche dichotomique dans un tableau trié coûte $O(\log n)$.
