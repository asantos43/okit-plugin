Harden setup autostart across client records, verify login readiness and exact cron commands, and localize failures while preserving rollback. / Reforça a inicialização automática no setup para todos os registros de clientes, verifica o início no login e comandos cron exatos, e traduz falhas preservando a restauração.

Resolve relative repair launchers and legacy setup records, require executable Node files and nonempty daemon scripts. / Resolve launchers relativos e registros legados no setup, exige arquivos Node executáveis e scripts do daemon não vazios.

Uninstall and update still remove the service when its daemon script is gone. / Desinstalar e atualizar ainda removem o serviço quando o script do daemon sumiu.

Uninstalling one client hands the service to a surviving client that can run it, or removes it when none can. / Desinstalar um cliente passa o serviço a um cliente restante que consiga executá-lo, ou o remove quando nenhum consegue.

Setup saves the records it enabled the autostart for with their resolved folders, so a legacy record can still be uninstalled with its service. / O setup grava os registros em que ativou o início automático com as pastas resolvidas, de modo que um registro legado ainda possa ser desinstalado junto com o serviço.
