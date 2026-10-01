---
title: Semaine 1
date: 2026-09-16
visible_from: 2026-09-16T08:00:00+02:00
author: Yves Chevallier
tags: [intro, c]
---

# Introduction

Le langage C a été créé par Dennis Ritchie.  
Ce saut de ligne est un *hard break* à deux espaces.\
Celui-ci est un saut avec une barre oblique inverse.

![Le schéma du compilateur](images/compilation.png)

La compilation se fait en quatre étapes :

1. le préprocesseur ;
2. la compilation ;
   1. analyse lexicale ;
   2. analyse syntaxique ;
3. l'assemblage ;
4. l'édition des liens.

## Premier programme

```c
#include <stdio.h>

int main(void) {
    printf("hello, world\n");
    return 0;
}
```

Compilez avec `gcc -Wall hello.c` puis lancez `./a.out`.

Voir aussi [la semaine suivante](../semaine-02.md) et [l'annexe](../annexe/outils.md#gcc).
