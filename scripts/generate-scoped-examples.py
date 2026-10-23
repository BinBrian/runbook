"""Generate fictional repository demos; never opens a user database or runs commands."""
import copy
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FOLDER = ROOT / 'docs' / 'examples' / 'blocks'
FOLDER.mkdir(parents=True, exist_ok=True)
STAMP = '2026-10-20T00:00:00.000Z'


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def parameter(key, name, description, default, owner=None):
    return dict(id=key, name=name, description=description, defaultValue=default, **({'ownerId': owner} if owner else {}))


def ref(key):
    return {'parameterId': key}


def cmd_step(key, title, text, group):
    return dict(id=key, title=[title], description=['复制到外部工具操作，然后人工确认本步结果。'],
                commands=[dict(id=key + '-cmd', text=text)], groupId=group)


def restart_document(group, environment_id, value):
    return dict(groups=[dict(id=group, name='更新重启服务', description='核对本次目标环境，再依次停止、发布、同步和启动服务。\n每个子步骤均由操作者确认结果，各环境的参数和记录独立。', sourceBlockId='restart-services-block')],
                parameters=[parameter(environment_id, '环境', '本次步骤块的环境，四个子步骤共用；与其他块及流程全局环境独立。', value, group)],
                steps=[cmd_step(group + '-' + action, title, [action + ' ', ref(environment_id)] + ([] if action == 'publishgame' else [' all']), group)
                       for action, title in [('stopserver', '停止服务'), ('publishgame', '发布游戏'), ('syncgame', '同步游戏'), ('startserver', '启动服务')]])


def block(key, name, document):
    document = copy.deepcopy(document)
    for group in document['groups']:
        group.pop('sourceBlockId', None)
    return dict(formatVersion=2, kind='block', id=key, name=name, document=document, createdAt=STAMP, updatedAt=STAMP)


restart = block('restart-services-block', '更新重启服务', restart_document('restart-definition-group', 'restart-environment', ''))
write(FOLDER / 'restart-services.runbook.json', restart)

group = 'transfer-definition-group'
fields = [('environment', '环境', '转区操作环境。', 'release'),
          ('sourceDistrict', '原区 districtno', 'target：玩家当前所在区服的 districtno。', ''),
          ('targetDistrict', '目标区 districtno', 'newdistrict：转区后的 districtno。', ''),
          ('playerId', '玩家 ID（通知用）', 'playerid：玩家 ID，群通知引用本参数。', ''),
          ('passcardId', '平台账号 ID', 'passcardid：平台账号 ID。', '')]
transfer = dict(groups=[dict(id=group, name='玩家转区', description='核对本玩家的原区、目标区、玩家 ID 和平台账号 ID。\n六个转区子步骤依次记录，群通知使用玩家 ID。')],
                parameters=[parameter(key, name, description, value, group) for key, name, description, value in fields], steps=[])
for operation, title in [('checktransfer', '检查转区'), ('exportplayer', '导出玩家'), ('importplayer', '导入玩家'),
                         ('refreshrole', '刷新角色'), ('deletesourceplayer', '删除原区玩家'), ('removerank', '移除排行')]:
    text = ['transferserver ', ref('environment'), ' ', ref('sourceDistrict'), ' ', ref('targetDistrict'), ' ', ref('playerId'), ' ', ref('passcardId'), ' ' + operation]
    transfer['steps'].append(cmd_step('transfer-' + operation, title, text, group))
transfer['steps'].append(dict(id='transfer-notice', title=['通知玩家 ', ref('playerId'), ' 操作结束'],
                             description=['在大群通知：', ref('playerId'), ' 操作结束，克隆进内服检查。\n通知使用玩家 ID（playerid）。'], commands=[], groupId=group))
write(FOLDER / 'transfer-player.runbook.json', block('transfer-player-block', '玩家转区', transfer))

# Four independent uses share only their definition provenance, never mutable values.
all_updates = dict(parameters=[parameter('main-environment', '环境', '流程全局环境；以下更新块使用自己的局部环境。', 'release')], groups=[], steps=[])
for environment, name in [('sandboxa', '示例环境A'), ('sandboxb', '示例环境B'), ('sandboxc', '示例环境C'), ('sandboxd', '示例环境D')]:
    document = restart_document('update-' + environment, 'environment-' + environment, environment)
    document['groups'][0]['name'] = f'{name} · 更新重启'
    for key in ('parameters', 'groups', 'steps'):
        all_updates[key].extend(document[key])
write(FOLDER / 'four-environments.runbook.json', dict(formatVersion=2, kind='template', id='four-environment-updates',
      name='多环境更新重启 · 四组独立局部参数', document=all_updates, createdAt=STAMP, updatedAt=STAMP))

# Rebuild the demo groups deterministically from the checked-in maintenance document.
path = ROOT / 'templates' / 'release-maintenance' / 'maintenance.runbook.json'
template = json.loads(path.read_text(encoding='utf-8'))
document = template['document']
document['groups'] = [dict(id='maintenance-announcement', name='维护预告', description='维护前一天确认本次起止时间，并在大群截图通知。')]
document['steps'] = [step for step in document['steps'] if not step['id'].startswith('update-sandboxa-')]
for step in document['steps']:
    step.pop('groupId', None)
    if step['id'] in ('day-before-maintain', 'day-before-notice'):
        step['groupId'] = 'maintenance-announcement'
    for number in range(1, 4):
        if step['id'].startswith(f'transfer-{number}-'):
            step['groupId'] = f'player-transfer-{number}'
            # Scope names are local, so they need not encode the player group number.
            if step['commands']:
                step['title'] = [next(title for action, title in [('checktransfer', '检查转区'), ('exportplayer', '导出玩家'),
                    ('importplayer', '导入玩家'), ('refreshrole', '刷新角色'), ('deletesourceplayer', '删除原区玩家'), ('removerank', '移除排行')]
                    if step['id'].endswith('-' + action))]
for number in range(1, 4):
    document['groups'].append(dict(id=f'player-transfer-{number}', name=f'玩家转区 {number}（如有）', description='只处理本组玩家；操作前核对原区、目标区、玩家 ID 和平台账号 ID。\n六个转区子步骤依次记录，完成后的群通知使用本组玩家 ID。', sourceBlockId='transfer-player-block'))
for item in document['parameters']:
    item.pop('ownerId', None)
    if item['id'] in ('maintenanceStart', 'maintenanceEnd'):
        item['ownerId'] = 'maintenance-announcement'
    elif item['id'] == 'sourceBranch':
        item['ownerId'] = 'copy-branch'
    elif item['id'].startswith('transfer'):
        number = int(item['id'][8])
        item['ownerId'] = f'player-transfer-{number}'
        item['name'] = item['name'].split(' · ', 1)[-1]

# Insert the four illustrative restart commands for the independent demo environment.
sandboxa = restart_document('update-sandboxa', 'sandboxa-environment', 'sandboxa')
sandboxa['groups'][0]['name'] = '示例环境A sandboxa · 更新重启'
index = next((i for i, step in enumerate(document['steps']) if step['id'] == 'restart-sandboxa'), None)
if index is not None:
    document['steps'][index:index + 1] = sandboxa['steps']
else:
    index = next(i for i, step in enumerate(document['steps']) if step['id'] == 'confirm-mail-sent')
    document['steps'][index:index] = sandboxa['steps']
document['parameters'] = [item for item in document['parameters'] if item['id'] != 'sandboxa-environment'] + sandboxa['parameters']
document['groups'].extend(sandboxa['groups'])
template['formatVersion'] = 2
write(path, template)

# Verify the 28 source-demo commands in order, plus the four restart-demo commands.
source = (path.parent / 'source.txt').read_text(encoding='utf-8')
expected = re.findall(r'(?m)^(?:maintain |confirmclose |stopserver |copybranch |publishgame |syncgame |transferserver release |startserver ).+$', source)
expected.append(source.split('邮件发送完成后开放登录:', 1)[1].strip())
values = {item['id']: item['defaultValue'] for item in document['parameters']}
values.update(maintenanceStart='2026-10-14-08-00', maintenanceEnd='2026-10-14-09-00')
render = lambda parts: ''.join(part if isinstance(part, str) else values[part['parameterId']] for part in parts)
actual = [render(command['text']) for step in document['steps'] for command in step['commands']]
extra = [f'stopserver sandboxa all', 'publishgame sandboxa', 'syncgame sandboxa all', 'startserver sandboxa all']
assert [item for item in actual if item not in extra] == expected
assert [item for item in actual if item in extra] == extra
assert len(document['steps']) == 46 and len(actual) == 32 and len(document['parameters']) == 17
for number in range(1, 4):
    notice = next(step for step in document['steps'] if step['id'] == f'transfer-{number}-notice')
    refs = {part['parameterId'] for part in notice['description'] if isinstance(part, dict)}
    assert refs == {f'transfer{number}PlayerId'}
print('PASS: fictional v2 maintenance 46 steps / 32 commands / 17 parameters; 28 source-demo commands and four restart commands verified')
print('PASS: self-contained restart/player blocks and four independently scoped environment examples generated')
