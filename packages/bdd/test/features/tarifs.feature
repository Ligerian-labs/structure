# language: fr
@tarifs
Fonctionnalité: Tarifs
  Contexte:
    Soit un tarif de 300 € par nuit pour la villa "savanne"
    Et "valentin@example.test" est connecté

  Plan du Scénario: Total pour <nuits> nuits
    Quand le client demande une réservation de <nuits> nuits à partir du "2026-07-01"
    Alors le total est de "<total>"
    Exemples:
      | nuits | total      |
      | 7     | 2 100,00 € |
      | 14    | 4 200,00 € |
      | 21    | 6 300,00 € |
