# Plan de interfaz web para HODL Wallet

## Objetivo y acuerdos

Crear una interfaz web con estética de terminal, manejable completamente desde
el teclado, disponible en `https://hodl-wallet.com`.

- La aplicación se ejecuta en el navegador, sin un proceso Node local.
- El dominio sirve archivos estáticos; no hay backend propio, cuentas remotas
  ni sincronización de wallets con un servidor.
- Las claves se generan, almacenan y utilizan para firmar en el dispositivo.
- La web vive en `apps/web` y depende de `hodl-wallet` mediante `workspace:*`.
- La CLI y la web comparten lógica de wallet. La CLI conserva su funcionamiento.

“Local” no significa que todas las funciones sean offline. Consultar saldos,
estimar comisiones, transmitir transacciones y hacer swaps requiere comunicarse
con las redes y proveedores. La carga inicial y las actualizaciones también
requieren descargar la aplicación desde el dominio.

Este documento propone las siguientes etapas. No autoriza por sí mismo nuevas
dependencias, cambios de contratos públicos, criptografía o despliegues.

## Estado actual

El monorepo ya contiene `packages/hodl-wallet`, con la CLI, redes, persistencia,
transferencias y swaps. La raíz delega los comandos al paquete y mantiene un
único lockfile con pnpm `12.3.4`.

El paquete todavía no es una biblioteca lista para navegador:

- Su entrada principal es la CLI.
- `WalletService` utiliza filesystem y bloqueos de perfiles de Node.
- `Persist` utiliza Deepbase, archivos y `node:crypto`.
- Los servicios de transferencias y swaps dependen de `Persist`; reutilizar solo
  las clases de redes no alcanza para conservar la recuperación de operaciones.
- Falta comprobar el empaquetado de las dependencias criptográficas y el acceso
  a los proveedores desde un navegador real.

## Arquitectura propuesta

```text
HODL/
├── packages/hodl-wallet/
│   ├── núcleo compartido y redes
│   ├── adaptadores Node y CLI
│   └── entrada pública para navegador
└── apps/web/
    ├── interfaz y navegación
    ├── bóveda y coordinación entre pestañas
    └── recursos estáticos y soporte offline
```

### Paquete compartido

Exponer una entrada explícita como `hodl-wallet/browser`. Su grafo de imports no
debe arrastrar la CLI, prompts de terminal, filesystem ni módulos exclusivos de
Node. Conservar las entradas existentes; no introducir un mapa de exports que
bloquee imports actualmente utilizables sin evaluar compatibilidad.

Compartir validación de direcciones, montos, derivación de cuentas, redes,
preparación y firma de transacciones, y coordinación de transferencias y swaps.
Separar únicamente las dependencias de entorno necesarias para esos casos:
persistencia durable, acceso a secretos, exclusión mutua y primitivas de entorno.

Definir esos contratos a partir de los servicios existentes, sin duplicar sus
reglas en la web ni construir una arquitectura de plugins nueva. El adaptador
Node debe conservar cifrado, archivos y comportamiento de la CLI.

### Aplicación web

Base propuesta: TypeScript, Vite y HTML/CSS con componentes pequeños. Para la
primera versión no se necesita SSR, un servidor de aplicación ni un emulador de
shell. Confirmar las nuevas dependencias antes de instalarlas.

La interfaz llama a operaciones tipadas de `hodl-wallet/browser`; los comandos
visibles son acciones de la wallet, nunca comandos arbitrarios del sistema.
La aplicación web es privada como paquete npm y genera un directorio de archivos
estáticos para desplegar. Sus scripts se ejecutan desde la raíz mediante filtros,
sin cambiar el significado de `pnpm start` para la CLI.

### Persistencia y configuración

Usar una bóveda cifrada en IndexedDB, con desbloqueo por contraseña y bloqueo
explícito. Los componentes visuales reciben datos públicos y resultados de
operaciones; el acceso a secretos queda concentrado en la capa de wallet.

Definir y revisar antes de implementar el formato versionado de la bóveda, la
derivación de clave, el cifrado autenticado y el formato de backup. No reemplazar
el cifrado existente con una alternativa improvisada ni prometer compatibilidad
con archivos `.HODL` sin comprobar su formato y restauración.

Mantener endpoints y política de operaciones en la configuración compartida.
Centralizar los valores exclusivos de la web, como bloqueo por inactividad y
actualizaciones, en su configuración; no repartir constantes entre componentes.

## Experiencia de terminal

- Pantalla principal con wallet, red, estado de conexión, saldos y acciones.
- Tipografía monoespaciada, contraste legible y jerarquía compacta; estados
  acompañados de texto, sin depender únicamente del color.
- Tab y Shift+Tab recorren controles; flechas navegan listas, Enter selecciona
  y Escape vuelve o cierra un diálogo. No interceptar la edición normal de texto.
- Paleta de acciones con búsqueda y autocompletado, accesible mediante un control
  visible y un atajo que no interfiera con el navegador o campos de entrada.
- Formularios guiados para dirección, activo y monto. Revisar red, destino, monto
  y comisión en una pantalla de confirmación antes de firmar o transmitir.
- Separar la confirmación del envío de la selección anterior: una repetición de
  Enter o un doble clic no puede ejecutar dos operaciones.
- Historial visual con estados claros. Ninguna contraseña, mnemonic, clave
  privada o transacción firmada aparece en el historial de comandos o logs.
- Mantener controles HTML semánticos, foco visible, lectura accesible de estados
  y uso con mouse o pantalla táctil además del teclado.

El alcance inicial propuesto incluye crear/importar una wallet, desbloquearla,
obtener direcciones, consultar saldos, enviar fondos y consultar el registro local
de operaciones. Ese registro no representa un historial completo de la cadena.
Los swaps se incorporan después de validar transferencias y recuperación.

## Datos locales, conectividad y recuperación

- Ofrecer exportación y restauración de un backup cifrado; explicar que borrar
  los datos del sitio puede borrar la bóveda y que no existe recuperación remota.
- No asumir acceso a `~/.HODL`. Cualquier intercambio con la CLI requiere una
  importación o exportación explícita del usuario.
- Coordinar pestañas para impedir mutaciones simultáneas sobre una misma wallet.
  Una pestaña sin exclusión mutua no puede firmar ni transmitir operaciones.
- Persistir la operación y su identidad antes del broadcast. Un timeout después
  del envío debe conducir a reconciliación, no a crear automáticamente otro pago.
- Al recargar, recuperar el registro y consultar el estado de operaciones
  pendientes. Mostrar estados desconocidos o pendientes como tales.
- Bloquear nuevas firmas al cerrar sesión; una transmisión ya iniciada no puede
  deshacerse por cerrar la pestaña o pulsar Escape.
- Mostrar datos cacheados con su antigüedad. Deshabilitar operaciones que requieren
  conexión cuando no hay información suficiente; no simular saldos o comisiones.
- Comprobar CORS, autenticación, límites y funcionamiento real de RPCs, servicios
  Bitcoin y proveedores de swaps desde el origen web. No incrustar claves privadas
  de API ni añadir un proxy propio como solución silenciosa.
- Mantener las reglas actuales de swaps: seguimiento de pendientes sin nuevos
  envíos, recuperación durable y resultados parciales diferenciados de completos.

## Distribución y actualizaciones

Servir la aplicación por HTTPS en `hodl-wallet.com`, con scripts, fuentes y demás
recursos propios incluidos en el build. Evitar scripts de terceros, analytics y
CDNs de código dentro del origen que contiene la bóveda.

El código servido por el dominio puede acceder a la wallet desbloqueada: revisar
dependencias, publicación y política de contenido forma parte de la seguridad.
Definir una CSP ajustada a los recursos y conexiones necesarias y probarla en el
hosting elegido. No se ha seleccionado hosting ni verificado el estado del dominio.

Añadir soporte instalable y caché de recursos estáticos después del flujo básico.
No guardar secretos o respuestas de la wallet en Cache Storage. Una actualización
no debe recargar durante una operación ni mezclar recursos de distintas versiones;
debe poder ofrecerse al terminar y con la wallet bloqueada.

## Etapas y criterios de aceptación

### 1. Validar viabilidad en navegador

Construir una prueba mínima de importación y ejecución del núcleo, sin fondos
reales. Verificar criptografía, derivación de direcciones, dependencias y acceso
a proveedores desde el navegador. Usar solo datos públicos para las comprobaciones
de red y no transmitir transacciones.

**Aceptación:** inventario concreto de adaptaciones necesarias y proveedores
utilizables sin backend. Un bloqueo de CORS o una dependencia incompatible se
resuelve o reduce el alcance antes de desarrollar las pantallas de operaciones.

### 2. Exponer el núcleo para navegador

Separar los contratos de entorno y conectar el adaptador Node existente. Agregar
la entrada para navegador y comprobar su contenido empaquetado.

**Aceptación:** mismos vectores de cuentas, direcciones, montos y firma en ambos
entornos; tests actuales de CLI, persistencia, transferencias y swaps aprobados;
bundle web sin dependencias exclusivas de Node.

### 3. Construir navegación y bóveda local

Crear `apps/web`, la navegación por teclado, creación/importación, bloqueo,
direcciones y exportación/restauración del backup. Implementar exclusión entre
pestañas antes de incorporar operaciones que mutan la wallet.

**Aceptación:** flujo completo solo con teclado; contraseña incorrecta y backup
alterado fallan explícitamente; recarga, bloqueo y restauración preservan los
datos esperados sin persistir secretos en texto plano.

### 4. Incorporar saldos y transferencias

Conectar lectura de redes, formularios, confirmación, firma y registro durable.
Implementar recuperación antes de considerar terminado el flujo de envío.

**Aceptación:** pruebas de destino inválido, fondos insuficientes, comisión
cambiante, doble confirmación, dos pestañas, cierre antes/después del broadcast
y timeout con resultado desconocido. Usar mocks y transacciones sin difusión;
cualquier prueba en testnet se acuerda aparte.

### 5. Incorporar swaps

Adaptar los proveedores que hayan pasado la validación web, manteniendo las rutas
y políticas del paquete. Añadir cotización, confirmación y seguimiento recuperable.

**Aceptación:** cotización vencida, proveedor inaccesible, fondos para fees,
recarga, devolución y ejecución parcial cubiertos por pruebas. No presentar un
swap parcial como completo ni reenviar fondos durante el seguimiento.

### 6. Preparar publicación estática

Implementar instalación/offline, CSP, actualizaciones y build reproducible.
Validar navegadores de escritorio Chromium, Firefox y Safari; mantener diseño
adaptable sin hacer del móvil un requisito inicial de producto.

**Aceptación:** assets locales, modo offline explícito, actualización sin pérdida
de operaciones y backup restaurable en una instalación limpia. Desplegar al
dominio únicamente con autorización y acceso al hosting/DNS correspondiente.

## Verificación y decisiones previas a implementar

Mantener los checks actuales del paquete y añadir pruebas de comportamiento del
adaptador web, además de recorridos de navegador con Playwright como herramienta
propuesta. Los tests no deben usar wallets reales, fondos ni secretos del usuario.

Confirmar antes de la etapa correspondiente:

1. Dependencias nuevas: Vite y herramienta de pruebas de navegador; cualquier
   sustitución criptográfica requiere una revisión específica.
2. Contratos públicos del núcleo y formato de bóveda/backup; compatibilidad con
   `.HODL` se evalúa explícitamente, no se presupone.
3. Alcance inicial propuesto y redes disponibles según la prueba de conectividad.
4. Parámetros de bloqueo y criptografía, soporte offline y política de actualización.
5. Hosting y procedimiento de despliegue de `hodl-wallet.com`.

No incluir en esta primera versión sincronización remota, cuentas de usuario,
extensión de navegador, conexión de dApps, hardware wallets, nuevas redes o un
flujo de firma air-gapped. Cada uno sería un alcance separado.
